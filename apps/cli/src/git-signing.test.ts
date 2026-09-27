import { afterEach, describe, expect, it } from 'bun:test'
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { isSshKeygenInvocation, runSshKeygenCompat, type GitSigningDependencies } from './git-signing'

function fakeDeps(overrides: Partial<GitSigningDependencies> = {}) {
  const calls: { sign: Array<{ squadId: string; payload: string }>; passthrough: string[][]; errors: string[] } = {
    sign: [],
    passthrough: [],
    errors: [],
  }
  const written = new Map<string, string>()
  const deps: GitSigningDependencies = {
    env: { FICUS_GIT_SIGNING_SQUAD: 'squad-1' },
    readFile: async (path) => Buffer.from(`payload of ${path}`),
    writeFile: async (path, content) => {
      written.set(path, content)
    },
    sign: async (squadId, payload) => {
      calls.sign.push({ squadId, payload: payload.toString() })
      return '-----BEGIN SSH SIGNATURE-----\nabc\n-----END SSH SIGNATURE-----\n'
    },
    passthrough: async (args) => {
      calls.passthrough.push(args)
      return 3
    },
    stderr: (line) => {
      calls.errors.push(line)
    },
    ...overrides,
  }
  return { deps, calls, written }
}

describe('ficus as gpg.ssh.program', () => {
  it('recognizes only ssh-keygen style invocations', () => {
    expect(isSshKeygenInvocation(['-Y', 'sign'])).toBe(true)
    expect(isSshKeygenInvocation(['ws', 'list'])).toBe(false)
    expect(isSshKeygenInvocation([])).toBe(false)
  })

  it('signs the buffer git names through Core and writes <buffer>.sig', async () => {
    const { deps, calls, written } = fakeDeps()
    const code = await runSshKeygenCompat(
      ['-Y', 'sign', '-n', 'git', '-f', '/tmp/.git_signing_key_tmpX', '-U', '/tmp/.git_signing_buffer_tmpY'],
      deps
    )
    expect(code).toBe(0)
    expect(calls.sign).toEqual([{ squadId: 'squad-1', payload: 'payload of /tmp/.git_signing_buffer_tmpY' }])
    expect(written.get('/tmp/.git_signing_buffer_tmpY.sig')).toContain('BEGIN SSH SIGNATURE')
    expect(calls.errors).toEqual([])
  })

  it('hands every non-sign operation to the real ssh-keygen unchanged', async () => {
    const { deps, calls } = fakeDeps()
    const args = ['-Y', 'find-principals', '-f', 'allowed', '-s', 'sig']
    expect(await runSshKeygenCompat(args, deps)).toBe(3)
    expect(calls.passthrough).toEqual([args])
    expect(calls.sign).toEqual([])
  })

  it('refuses other namespaces, missing buffers and use outside the squad wrapper', async () => {
    for (const [args, env] of [
      [['-Y', 'sign', '-n', 'file', '-f', 'k', 'buf'], { FICUS_GIT_SIGNING_SQUAD: 's' }],
      [['-Y', 'sign', '-n', 'git', '-f', 'k'], { FICUS_GIT_SIGNING_SQUAD: 's' }],
      [['-Y', 'sign', '-n', 'git', '-f', 'k', 'buf'], {}],
    ] as const) {
      const { deps, calls } = fakeDeps({ env })
      expect(await runSshKeygenCompat([...args], deps)).toBe(1)
      expect(calls.sign).toEqual([])
      expect(calls.errors).toHaveLength(1)
    }
  })

  it("reports Core's refusal and leaves no signature behind", async () => {
    const { deps, calls, written } = fakeDeps({
      sign: async () => {
        throw new Error('Commit signing is off for this squad’s GitHub account.')
      },
    })
    expect(await runSshKeygenCompat(['-Y', 'sign', '-n', 'git', '-f', 'k', '-U', 'buf'], deps)).toBe(1)
    expect(calls.errors).toEqual([
      'ficus: commit signing failed: Commit signing is off for this squad’s GitHub account.',
    ])
    expect(written.size).toBe(0)
  })
})

describe('git signing through the real ficus entrypoint', () => {
  const dirs: string[] = []
  let server: ReturnType<typeof Bun.serve> | undefined
  afterEach(async () => {
    await server?.stop(true)
    server = undefined
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  function run(command: string[], cwd: string, env: Record<string, string>) {
    const result = Bun.spawnSync(command, { cwd, env, stdout: 'pipe', stderr: 'pipe' })
    return { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() }
  }
  /** For git runs that reach the in-process server: a sync spawn would block the loop serving it. */
  async function runAsync(command: string[], cwd: string, env: Record<string, string>) {
    const child = Bun.spawn(command, { cwd, env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    return { code, stdout, stderr }
  }

  it('commits signed via Core and verifies through the ssh-keygen passthrough', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'tau-git-sign-e2e-')))
    dirs.push(dir)
    const repo = join(dir, 'repo')
    const bin = join(dir, 'bin')
    expect(run(['mkdir', '-p', repo, bin, join(dir, 'home')], dir, { PATH: '/usr/bin:/bin' }).code).toBe(0)
    // The key Core would hold; here a stand-in for the sign endpoint uses it via ssh-keygen.
    expect(
      run(['ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-f', join(dir, 'key')], dir, { PATH: '/usr/bin:/bin' }).code
    ).toBe(0)
    const publicKey = readFileSync(join(dir, 'key.pub'), 'utf8').trim()

    const requests: Array<{ path: string; auth: string | null }> = []
    server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      async fetch(request) {
        const url = new URL(request.url)
        requests.push({ path: url.pathname, auth: request.headers.get('authorization') })
        const { payload } = (await request.json()) as { payload: string }
        const file = join(dir, `payload-${requests.length}`)
        writeFileSync(file, Buffer.from(payload, 'base64'))
        const signed = Bun.spawnSync(['ssh-keygen', '-Y', 'sign', '-n', 'git', '-f', join(dir, 'key'), file], {
          stdout: 'pipe',
          stderr: 'pipe',
        })
        if (signed.exitCode !== 0) return Response.json({ error: signed.stderr.toString() }, { status: 500 })
        return Response.json({ signature: readFileSync(`${file}.sig`, 'utf8') })
      },
    })

    // Production puts `tau` on PATH and sets gpg.ssh.program=tau; mirror that.
    writeFileSync(
      join(bin, 'tau'),
      `#!/bin/sh\nexec "${process.execPath}" "${join(import.meta.dir, 'index.ts')}" "$@"\n`
    )
    chmodSync(join(bin, 'tau'), 0o755)
    writeFileSync(join(dir, 'allowed'), `agent@example.com ${publicKey}\n`)
    const env = {
      PATH: `${bin}:/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin`,
      HOME: join(dir, 'home'),
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'Agent',
      GIT_AUTHOR_EMAIL: 'agent@example.com',
      GIT_COMMITTER_NAME: 'Agent',
      GIT_COMMITTER_EMAIL: 'agent@example.com',
      FICUS_AGENT_CONTEXT: '1',
      FICUS_API_URL: `http://127.0.0.1:${server.port}`,
      FICUS_TOKEN: 'tau_agent_e2e',
      FICUS_AUTH_STORE: join(dir, 'auth.json'),
      FICUS_GIT_SIGNING_SQUAD: 'squad-e2e',
    }
    const signing = [
      '-c',
      'gpg.format=ssh',
      '-c',
      'commit.gpgsign=true',
      '-c',
      `user.signingkey=key::${publicKey}`,
      '-c',
      'gpg.ssh.program=tau',
      '-c',
      `gpg.ssh.allowedSignersFile=${join(dir, 'allowed')}`,
    ]
    expect(run(['git', 'init', '-q'], repo, env).code).toBe(0)
    const commit = await runAsync(
      ['git', ...signing, 'commit', '-q', '--allow-empty', '-m', 'signed by tau'],
      repo,
      env
    )
    expect(commit.stderr).toBe('')
    expect(commit.code).toBe(0)
    expect(requests).toEqual([{ path: '/api/squads/squad-e2e/integrations/github/sign', auth: 'Bearer tau_agent_e2e' }])

    const verify = await runAsync(['git', ...signing, 'verify-commit', 'HEAD'], repo, env)
    expect(verify.stderr).toContain('Good "git" signature for agent@example.com')
    expect(verify.code).toBe(0)
  }, 30_000)
})
