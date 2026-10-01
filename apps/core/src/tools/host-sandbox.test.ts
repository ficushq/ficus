import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createHash } from 'crypto'
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  clampHostBashTimeout,
  createHostBashTool,
  createHostSandboxedCodingTools,
  createLocalVerifiedEditOperations,
  HOST_BASH_DEFAULT_TIMEOUT_S,
  HOST_BASH_MAX_TIMEOUT_S,
} from './host-sandbox'
import { clearHostWorkspaceOverrides } from '../services/sandbox/host/workspace-overrides'
import { resetHostBaseEnvCache } from '../services/sandbox/host/env'

const SQUAD = '11111111-2222-4333-8444-555555555555'
const sha = (s: string) => createHash('sha256').update(s).digest('hex')

async function run(
  tool: { execute: (id: string, input: unknown, signal?: AbortSignal) => Promise<unknown> },
  input: unknown,
  signal?: AbortSignal
) {
  const result = (await tool.execute('call-1', input, signal)) as { content: Array<{ type: string; text?: string }> }
  return result.content.map((c) => c.text ?? '').join('')
}

describe('host sandboxed coding tools', () => {
  let home: string
  let prevHome: string | undefined
  let prevRuntime: string | undefined
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'ficus-host-tools-'))
    prevHome = process.env.HOME_DIR
    prevRuntime = process.env.FICUS_SANDBOX_RUNTIME
    process.env.HOME_DIR = home
    process.env.FICUS_SANDBOX_RUNTIME = 'host'
    clearHostWorkspaceOverrides()
    resetHostBaseEnvCache()
    mkdirSync(join(home, 'private', 'agent_a1'), { recursive: true })
    mkdirSync(join(home, 'workspaces', 'squads', SQUAD, '.ficus'), { recursive: true })
    writeFileSync(join(home, 'workspaces', 'squads', SQUAD, '.ficus', '.env'), 'FROM_SQUAD_ENV=yes\n')
  })
  afterEach(() => {
    clearHostWorkspaceOverrides()
    resetHostBaseEnvCache()
    if (prevHome === undefined) delete process.env.HOME_DIR
    else process.env.HOME_DIR = prevHome
    if (prevRuntime === undefined) delete process.env.FICUS_SANDBOX_RUNTIME
    else process.env.FICUS_SANDBOX_RUNTIME = prevRuntime
    rmSync(home, { recursive: true, force: true })
  })

  test('produces read/write/edit/bash with stable keys', () => {
    const tools = createHostSandboxedCodingTools('', 'agent_a1', 'tok', SQUAD)
    expect(tools.map((t) => t.key)).toEqual(['read', 'write', 'edit', 'bash'])
  })

  test('bash starts in the private dir, sees TAU vars and the squad .ficus/.env, not worker secrets', async () => {
    const canary = `CANARY_${Date.now()}`
    process.env[canary] = 'leaked'
    try {
      const bash = createHostSandboxedCodingTools('', 'agent_a1', 'tok', SQUAD).find((t) => t.key === 'bash')!
      const out = await run(bash, {
        command: `pwd; echo tok=$FICUS_TOKEN; echo url=$FICUS_API_URL; echo env=$FROM_SQUAD_ENV; echo canary=\${${canary}:-absent}`,
      })
      expect(out).toContain(join(home, 'private', 'agent_a1'))
      expect(out).toContain('tok=tok')
      expect(out).toContain('url=http://127.0.0.1:')
      expect(out).toContain('env=yes')
      expect(out).toContain('canary=absent')
    } finally {
      delete process.env[canary]
    }
  })

  test('a hostile squad .ficus/.env cannot make the agent act as another identity, instance, or `ficus`', async () => {
    // The reported clash, plus the two ways a squad env can defeat a naive fix:
    // poisoning the FICUS_IDENTITY_* aliases the preamble reads, and moving `ficus`.
    const impostorDir = join(home, 'impostor-bin')
    const shimDir = join(home, 'host', 'bin')
    mkdirSync(impostorDir, { recursive: true })
    mkdirSync(shimDir, { recursive: true })
    for (const [dir, who] of [
      [impostorDir, 'impostor'],
      [shimDir, 'shim'],
    ]) {
      writeFileSync(join(dir, 'ficus'), `#!/bin/sh\necho ${who}\n`)
      chmodSync(join(dir, 'ficus'), 0o755)
    }
    writeFileSync(
      join(home, 'workspaces', 'squads', SQUAD, '.ficus', '.env'),
      [
        'FICUS_API_URL=https://cloud.example.com',
        'FICUS_TOKEN=operator-token',
        'FICUS_AUTH_STORE=/home/operator/.tau/cli/auth.json',
        'FICUS_AGENT_ID=someone-else',
        // The aliases are ordinary variables: a squad env that sets these used to
        // be promoted straight back into the real names by the re-assertion.
        'FICUS_IDENTITY_API_URL=https://cloud.example.com',
        'FICUS_IDENTITY_TOKEN=operator-token',
        'FICUS_IDENTITY_AUTH_STORE=/home/operator/.tau/cli/auth.json',
        'FICUS_IDENTITY_AGENT_ID=someone-else',
        // …and so were the preamble's own snapshot names, until they gained a
        // per-command random suffix. These are the fixed names it used to use.
        '__ficus_api_url=https://cloud.example.com',
        '__ficus_url=https://cloud.example.com',
        '__ficus_token=operator-token',
        '__ficus_tok=operator-token',
        '__ficus_auth_store=/home/operator/.tau/cli/auth.json',
        '__ficus_store=/home/operator/.tau/cli/auth.json',
        '__ficus_agent_id=someone-else',
        '__ficus_agent=someone-else',
        `__ficus_bin_dir=${impostorDir}`,
        `__ficus_bin=${impostorDir}`,
        // A hostile PATH prepend…
        `PATH=${impostorDir}:$PATH`,
        // …and a perfectly legitimate one, which must survive.
        'PATH=$PATH:/opt/x',
        'FROM_SQUAD_ENV=yes',
        '',
      ].join('\n')
    )
    const bash = createHostSandboxedCodingTools('', 'agent_a1', 'tok', SQUAD).find((t) => t.key === 'bash')!
    const out = await run(bash, {
      command:
        'echo url=$FICUS_API_URL; echo tok=$FICUS_TOKEN; echo store=$FICUS_AUTH_STORE; echo ctx=$FICUS_AGENT_CONTEXT; echo id=$FICUS_AGENT_ID; echo env=$FROM_SQUAD_ENV; echo alias=${FICUS_IDENTITY_TOKEN:-unset}; echo ficus=$(ficus); echo path=$PATH',
    })
    expect(out).toContain('url=http://127.0.0.1:')
    expect(out).toContain('tok=tok')
    expect(out).toContain(`store=${join(home, 'host', 'cli-auth', 'a1.json')}`)
    expect(out).toContain('ctx=1')
    expect(out).toContain('id=a1')
    // `ficus` is the runtime's shim, not the squad env's impostor…
    expect(out).toContain('ficus=shim')
    expect(out).toContain(`path=${shimDir}:`)
    // …while everything else the squad env asked for still applies, including a
    // legitimate PATH addition.
    expect(out).toContain('env=yes')
    expect(out).toContain(impostorDir)
    expect(out).toContain(':/opt/x')
    // The aliases are scaffolding, not part of the agent's environment.
    expect(out).toContain('alias=unset')
  })

  test('a stale squad .ficus/.env cannot hand a credential to a shell that was given none', async () => {
    writeFileSync(
      join(home, 'workspaces', 'squads', SQUAD, '.ficus', '.env'),
      'FICUS_TOKEN=stale-operator-token\nFICUS_AUTH_STORE=/home/operator/.tau/cli/auth.json\nFICUS_AGENT_CONTEXT=1\n'
    )
    const bash = createHostBashTool(join(home, 'private', 'agent_a1'), { squadId: SQUAD })
    const out = await run(bash, {
      command:
        'echo tok=${FICUS_TOKEN:-unset}; echo store=${FICUS_AUTH_STORE:-unset}; echo ctx=${FICUS_AGENT_CONTEXT:-unset}',
    })
    expect(out).toContain('tok=unset')
    expect(out).toContain('store=unset')
    expect(out).toContain('ctx=unset')
  })

  test('each command gets fresh snapshot names, so an earlier command cannot publish them', async () => {
    // The preamble is prepended to the command string, i.e. argv — which the
    // agent's own command can read. Names reused across commands would let
    // command 1 learn them and command 2's squad env assign them, restoring the
    // exact override this whole mechanism exists to stop.
    const bash = createHostBashTool(join(home, 'private', 'agent_a1'), { squadId: SQUAD, ficusToken: 'tok' })
    // The trailing `:` matters: bash exec-optimizes a lone simple command,
    // replacing its own argv with `ps`'s, and the preamble would vanish from
    // the very listing we are reading.
    const readOwnArgv = 'ps -ww -o args= -p $$; :'
    const first = await run(bash, { command: readOwnArgv })
    const second = await run(bash, { command: readOwnArgv })
    const nameOf = (argv: string) => argv.match(/__ficus_[0-9a-f]{6}_url/)?.[0]
    // Guard the probe itself: a `ps` that printed nothing would make the
    // inequality below pass vacuously with two undefineds.
    expect(nameOf(first)).toMatch(/^__ficus_[0-9a-f]{6}_url$/)
    expect(nameOf(second)).toMatch(/^__ficus_[0-9a-f]{6}_url$/)
    expect(nameOf(second)).not.toBe(nameOf(first))
  })

  test('the agent id the runner passes wins over the one derivable from the sandbox id', async () => {
    // System-manager boxes are `system_manager_<ownerUserId>` and descendants can
    // share a box, so the sandbox id is not a reliable agent id.
    mkdirSync(join(home, 'private', 'system_manager_owner-9'), { recursive: true })
    const bash = createHostSandboxedCodingTools(
      '',
      'system_manager_owner-9',
      'tok',
      undefined,
      undefined,
      'agent-7'
    ).find((t) => t.key === 'bash')!
    const out = await run(bash, { command: 'echo id=$FICUS_AGENT_ID; echo store=$FICUS_AUTH_STORE' })
    expect(out).toContain('id=agent-7')
    expect(out).toContain(`store=${join(home, 'host', 'cli-auth', 'agent-7.json')}`)
  })

  test('bash timeout kills the command', async () => {
    const bash = createHostBashTool(join(home, 'private', 'agent_a1'), {})
    const started = Date.now()
    // pi's createBashToolDefinition catches the operations.exec `timeout:<n>` throw
    // and rewraps it as this exact message (bash.js formatOutput/catch block) — pin
    // it so a regression that swallows or renames the timeout error is caught.
    await expect(run(bash, { command: 'sleep 20', timeout: 1 })).rejects.toThrow(/Command timed out after 1 seconds/)
    expect(Date.now() - started).toBeLessThan(10_000)
  })

  test('read/write round trip on absolute paths; relative paths rejected with a host path hint', async () => {
    const tools = createHostSandboxedCodingTools('', 'agent_a1', undefined, SQUAD)
    const write = tools.find((t) => t.key === 'write')!
    const read = tools.find((t) => t.key === 'read')!
    const file = join(home, 'workspaces', 'squads', SQUAD, 'hello.txt')
    await run(write, { path: file, content: 'hi\n' })
    expect(readFileSync(file, 'utf8')).toBe('hi\n')
    expect(await run(read, { path: file })).toContain('hi')
    await expect(run(read, { path: 'hello.txt' })).rejects.toThrow(join(home, 'workspaces', 'squads', SQUAD))
  })

  test('local verified edit commits only when the on-disk identity matches', async () => {
    const ops = createLocalVerifiedEditOperations()
    const file = join(home, 'private', 'agent_a1', 'f.txt')
    writeFileSync(file, 'abc')
    const result = Buffer.from('abd')
    const res = await ops.commitFile(file, result, {
      original: { bytes: 3, sha256: sha('abc') },
      result: { bytes: 3, sha256: sha('abd') },
    })
    expect(res).toEqual({ bytesWritten: 3, sha256: sha('abd') })
    expect(readFileSync(file, 'utf8')).toBe('abd')
    await expect(
      ops.commitFile(file, Buffer.from('zzz'), {
        original: { bytes: 3, sha256: sha('abc') }, // stale: file is now 'abd'
        result: { bytes: 3, sha256: sha('zzz') },
      })
    ).rejects.toThrow('changed on disk')
    expect(readFileSync(file, 'utf8')).toBe('abd')
  })

  test('edit tool applies an exact replacement', async () => {
    const tools = createHostSandboxedCodingTools('', 'agent_a1', undefined, SQUAD)
    const edit = tools.find((t) => t.key === 'edit')!
    const file = join(home, 'private', 'agent_a1', 'e.txt')
    writeFileSync(file, 'one two three\n')
    await run(edit, { path: file, oldText: 'two', newText: '2' })
    expect(readFileSync(file, 'utf8')).toBe('one 2 three\n')
  })

  test('local verified edit commits through a symlink without replacing the link itself', async () => {
    const ops = createLocalVerifiedEditOperations()
    const dir = join(home, 'private', 'agent_a1')
    const target = join(dir, 'target.txt')
    const link = join(dir, 'link.txt')
    writeFileSync(target, 'abc')
    symlinkSync(target, link)
    const result = Buffer.from('abd')
    const res = await ops.commitFile(link, result, {
      original: { bytes: 3, sha256: sha('abc') },
      result: { bytes: 3, sha256: sha('abd') },
    })
    expect(res).toEqual({ bytesWritten: 3, sha256: sha('abd') })
    expect(lstatSync(link).isSymbolicLink()).toBe(true)
    expect(readlinkSync(link)).toBe(target)
    expect(readFileSync(target, 'utf8')).toBe('abd')
  })

  test('local verified edit rejects a dangling symlink and a non-regular file', async () => {
    const ops = createLocalVerifiedEditOperations()
    const dir = join(home, 'private', 'agent_a1')
    const dangling = join(dir, 'dangling.txt')
    symlinkSync(join(dir, 'does-not-exist.txt'), dangling)
    await expect(
      ops.commitFile(dangling, Buffer.from('x'), {
        original: { bytes: 0, sha256: sha('') },
        result: { bytes: 1, sha256: sha('x') },
      })
    ).rejects.toThrow(/dangling symlink|does not exist/)

    const notRegular = join(dir, 'a-directory')
    mkdirSync(notRegular)
    await expect(
      ops.commitFile(notRegular, Buffer.from('x'), {
        original: { bytes: 0, sha256: sha('') },
        result: { bytes: 1, sha256: sha('x') },
      })
    ).rejects.toThrow(/not a regular file/)
  })

  test('local verified edit leaves no ficus-edit.tmp behind when the commit fails after staging', async () => {
    const dir = join(home, 'private', 'agent_a1')
    const file = join(dir, 'stage-fail.txt')
    writeFileSync(file, 'abc')
    const ops = createLocalVerifiedEditOperations({
      rename: async () => {
        throw new Error('simulated rename failure')
      },
    })
    await expect(
      ops.commitFile(file, Buffer.from('abd'), {
        original: { bytes: 3, sha256: sha('abc') },
        result: { bytes: 3, sha256: sha('abd') },
      })
    ).rejects.toThrow('simulated rename failure')
    expect(readFileSync(file, 'utf8')).toBe('abc')
    const leftover = readdirSync(dir).filter((name) => name.includes('ficus-edit.tmp'))
    expect(leftover).toEqual([])
  })

  test('local verified edit preserves the original file mode across umask', async () => {
    const dir = join(home, 'private', 'agent_a1')
    const file = join(dir, 'mode.txt')
    writeFileSync(file, 'abc')
    chmodSync(file, 0o664)
    const ops = createLocalVerifiedEditOperations()
    await ops.commitFile(file, Buffer.from('abd'), {
      original: { bytes: 3, sha256: sha('abc') },
      result: { bytes: 3, sha256: sha('abd') },
    })
    expect(statSync(file).mode & 0o777).toBe(0o664)
  })
})

describe('clampHostBashTimeout', () => {
  test('undefined falls back to the default', () => {
    expect(clampHostBashTimeout(undefined)).toBe(HOST_BASH_DEFAULT_TIMEOUT_S)
  })

  test('a value within bounds passes through unchanged', () => {
    expect(clampHostBashTimeout(60)).toBe(60)
  })

  test('a value above the max is capped', () => {
    expect(clampHostBashTimeout(99999)).toBe(HOST_BASH_MAX_TIMEOUT_S)
  })

  test('non-finite values fall back to the default', () => {
    expect(clampHostBashTimeout(Number.NaN)).toBe(HOST_BASH_DEFAULT_TIMEOUT_S)
    expect(clampHostBashTimeout(Number.POSITIVE_INFINITY)).toBe(HOST_BASH_DEFAULT_TIMEOUT_S)
  })
})
