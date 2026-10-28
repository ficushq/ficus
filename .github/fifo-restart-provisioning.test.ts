import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dir, '..')
const fixture = 'apps/core/src/db/fixtures/message-enqueue-restart.compose.yml'
const standalone = 'apps/core/src/db/message-enqueue-order-restart.standalone.ts'
const read = (file: string) => readFileSync(join(root, file), 'utf8')

async function withDocker(body: (dir: string, env: NodeJS.ProcessEnv) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'fifo-provisioning-'))
  try {
    await body(dir, { ...process.env, PATH: `${dir}:${process.env.PATH}`, DOCKER_LOG: join(dir, 'docker.log') })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function executable(dir: string, name: string, body: string) {
  writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 })
}

async function invoke(command: string[], env: NodeJS.ProcessEnv) {
  const child = Bun.spawn(command, { cwd: root, env, stdout: 'pipe', stderr: 'pipe' })
  try {
    const [exit, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    return { exit, output: stdout + stderr }
  } finally {
    child.kill('SIGKILL')
    await child.exited
  }
}

const testCommand = [process.execPath, '--config=./bunfig.fifo-restart.toml', 'test', `./${standalone}`]

test('CI provisions the exact digest-pinned fixture before the non-retried restart test', () => {
  expect(read(fixture)).toMatch(/image: postgres:16@sha256:[a-f0-9]{64}/)
  const ci = read('.github/workflows/ci.yml')
  expect(ci).toContain('run: bash .github/pull-fifo-restart.sh')
  expect(ci).toContain('bun test ./fifo-restart-provisioning.test.ts')
  expect(ci.indexOf('run: bash .github/pull-fifo-restart.sh')).toBeLessThan(
    ci.indexOf('run: bun run test:core:fifo-restart')
  )
})

for (const succeeds of [true, false]) {
  test(`image acquisition ${succeeds ? 'recovers on the third attempt' : 'fails after three attempts with the final registry error'}`, async () => {
    await withDocker(async (dir, env) => {
      executable(
        dir,
        'docker',
        `
printf '%s\\n' "$*" >> "$DOCKER_LOG"
case "$*" in
  *'config --images'*) echo 'postgres:16@sha256:fixture'; exit 0;;
esac
attempt=$(grep -c ' pull postgres' "$DOCKER_LOG")
echo "postgres Pulling: attempt $attempt" >&2
${succeeds ? '[ "$attempt" -eq 3 ] && exit 0' : ''}
echo 'registry.invalid: no such host (end of stderr)' >&2
exit 17`
      )
      // Avoid waiting in hermetic tests, but verify the real script's timeout and backoff arguments.
      executable(dir, 'timeout', 'printf "timeout %s\\n" "$*" >> "$DOCKER_LOG.policy"; shift 2; exec "$@"')
      executable(dir, 'sleep', 'printf "sleep %s\\n" "$*" >> "$DOCKER_LOG.policy"')
      const result = await invoke(['bash', '.github/pull-fifo-restart.sh'], env)
      expect(result.exit).toBe(succeeds ? 0 : 17)
      const calls = readFileSync(env.DOCKER_LOG!, 'utf8')
      expect(calls.match(/ pull postgres/g)).toHaveLength(3)
      expect(calls).toContain(`-f ${join(root, fixture)}`)
      expect(calls).not.toMatch(/ (up|restart|exec) /)
      const policy = readFileSync(`${env.DOCKER_LOG}.policy`, 'utf8')
      expect(policy.match(/timeout --kill-after=5s 120s/g)).toHaveLength(3)
      expect(policy).toContain('sleep 5')
      expect(policy).toContain('sleep 10')
      expect(result.output).toContain('registry.invalid: no such host (end of stderr)')
      expect(result.output).toContain('attempt 3/3')
      if (!succeeds) expect(result.output).toContain('Image provisioning failed after 3 attempts (exit 17)')
    })
  })
}

test('compose failures print the stderr end explicitly and do not retry up', async () => {
  await withDocker(async (dir, env) => {
    executable(
      dir,
      'docker',
      `
printf '%s\\n' "$*" >> "$DOCKER_LOG"
case "$*" in
  *'up -d'*)
    head -c 24000 /dev/zero | tr '\\000' x >&2
    echo 'FINAL-COMPOSE-ERROR: registry.invalid: no such host' >&2
    exit 23;;
esac`
    )
    const result = await invoke(testCommand, env)
    expect(result.exit).not.toBe(0)
    expect(result.output).toContain('compose stderr (tail):')
    expect(result.output).toContain('FINAL-COMPOSE-ERROR: registry.invalid: no such host')
    expect(result.output).toContain('exit=23')
    const calls = readFileSync(env.DOCKER_LOG!, 'utf8')
    expect(calls.match(/up -d --pull never/g)).toHaveLength(1)
    expect(calls).toContain('down -v --remove-orphans --timeout 2')
  })
})

test('a timed-out compose operation reports its signal and unchanged short deadline', async () => {
  await withDocker(async (dir, env) => {
    executable(
      dir,
      'docker',
      `
printf '%s\\n' "$*" >> "$DOCKER_LOG"
case "$*" in
  *'up -d'*) echo 'postgres Pulling' >&2; exec sleep 11;;
esac`
    )
    const result = await invoke(testCommand, env)
    expect(result.exit).not.toBe(0)
    expect(result.output).toContain('signal=SIGKILL')
    expect(result.output).toContain('timeout=10000ms')
    expect(result.output).toContain('compose stderr (tail):\npostgres Pulling')
  })
}, 15000)
