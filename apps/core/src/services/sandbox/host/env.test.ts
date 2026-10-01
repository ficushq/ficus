import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  FALLBACK_PATH,
  buildHostCommandEnv,
  buildHostPreamble,
  ensureCliShim,
  getHostBaseEnv,
  hostBinDir,
  parseNulSeparatedEnv,
  resetHostBaseEnvCache,
  resolveHostApiUrl,
  seedEnv,
  setSpawnSyncOverrideForTests,
  snapshotLoginEnv,
} from './env'

const SQUAD = '11111111-2222-4333-8444-555555555555'

describe('host env', () => {
  let home: string
  let prevHome: string | undefined
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'ficus-host-env-'))
    prevHome = process.env.HOME_DIR
    process.env.HOME_DIR = home
    resetHostBaseEnvCache()
    setSpawnSyncOverrideForTests(null)
  })
  afterEach(() => {
    resetHostBaseEnvCache()
    setSpawnSyncOverrideForTests(null)
    if (prevHome === undefined) delete process.env.HOME_DIR
    else process.env.HOME_DIR = prevHome
    rmSync(home, { recursive: true, force: true })
  })

  test('seedEnv copies only identity keys, never secrets', () => {
    const seed = seedEnv({ HOME: '/h', USER: 'u', DATABASE_URL: 'postgres://x', ANTHROPIC_API_KEY: 'k', TERM: 'xterm' })
    expect(seed).toEqual({ HOME: '/h', USER: 'u', TERM: 'xterm' })
  })

  test('parseNulSeparatedEnv handles values containing = and newlines', () => {
    const parsed = parseNulSeparatedEnv('A=1\0B=x=y\0C=line1\nline2\0')
    expect(parsed).toEqual({ A: '1', B: 'x=y', C: 'line1\nline2' })
  })

  test('snapshotLoginEnv runs the login shell with ONLY the seed env (worker secrets absent)', () => {
    const canary = `CANARY_${Date.now()}`
    process.env[canary] = 'leaked'
    try {
      const env = snapshotLoginEnv({
        seed: { HOME: home, USER: 'tester', SHELL: '/bin/bash', TERM: 'dumb' },
        shell: '/bin/bash',
      })
      expect(env[canary]).toBeUndefined()
      expect(env.HOME).toBe(home)
      expect(typeof env.PATH).toBe('string')
      expect(env.PATH!.length).toBeGreaterThan(0)
    } finally {
      delete process.env[canary]
    }
  })

  test('snapshotLoginEnv keeps the seed identity keys even when the login profile re-exports them', () => {
    // Some distros/CI runners' login profiles re-export HOME (and friends) themselves;
    // the agent's identity must still be the core user's, not whatever the profile sets.
    const fakeSpawnSync = (() => ({
      exitCode: 0,
      stdout: Buffer.from(`__FICUS_ENV__\0HOME=/elsewhere\0USER=other\0PATH=/p\0LANG=xx\0`),
      stderr: Buffer.from(''),
    })) as unknown as typeof Bun.spawnSync
    const env = snapshotLoginEnv({
      seed: { HOME: home, USER: 'tester', SHELL: '/bin/bash' },
      spawnSync: fakeSpawnSync,
    })
    expect(env.HOME).toBe(home)
    expect(env.USER).toBe('tester')
    // Non-identity keys the profile sets/overrides pass through untouched.
    expect(env.PATH).toBe('/p')
    expect(env.LANG).toBe('xx')
  })

  test('snapshotLoginEnv falls back to seed + FALLBACK_PATH when the shell fails', () => {
    const env = snapshotLoginEnv({ seed: { HOME: home }, shell: '/definitely/not/a/shell' })
    expect(env).toEqual({ HOME: home, PATH: FALLBACK_PATH })
  })

  test('snapshotLoginEnv drops shell-startup banner noise before the env sentinel', () => {
    const fakeSpawnSync = (() => ({
      exitCode: 0,
      stdout: Buffer.from(`Welcome to bash!\nMessage of the day...\n__FICUS_ENV__\0PATH=/good/bin\0HOME=${home}\0`),
      stderr: Buffer.from(''),
    })) as unknown as typeof Bun.spawnSync
    const env = snapshotLoginEnv({ seed: { HOME: home }, spawnSync: fakeSpawnSync })
    // Without sentinel-slicing, the banner's leading "Welcome to bash!\n" would prepend onto
    // the first record and corrupt its key, silently losing PATH to the fallback below.
    expect(env.PATH).toBe('/good/bin')
    expect(env.HOME).toBe(home)
  })

  test('getHostBaseEnv caches until reset (does not re-run the login shell)', () => {
    let calls = 0
    setSpawnSyncOverrideForTests(() => {
      calls++
      return {
        exitCode: 0,
        stdout: Buffer.from(`__FICUS_ENV__\0PATH=/cached/bin\0HOME=${home}\0`),
        stderr: Buffer.from(''),
      }
    })
    const first = getHostBaseEnv()
    expect(calls).toBe(1)
    const second = getHostBaseEnv()
    expect(calls).toBe(1)
    expect(second).toEqual(first)
    resetHostBaseEnvCache()
    getHostBaseEnv()
    expect(calls).toBe(2)
  })

  test('getHostBaseEnv returns a fresh copy each call so callers cannot mutate the cache', () => {
    setSpawnSyncOverrideForTests(() => ({
      exitCode: 0,
      stdout: Buffer.from(`__FICUS_ENV__\0PATH=/fresh/bin\0HOME=${home}\0`),
      stderr: Buffer.from(''),
    }))
    const first = getHostBaseEnv()
    ;(first as Record<string, string>).INJECTED = 'mutated'
    const second = getHostBaseEnv()
    expect(second).not.toBe(first)
    expect(second.INJECTED).toBeUndefined()
  })

  test('getHostBaseEnv does not cache a failed snapshot; retries until success, then caches', () => {
    setSpawnSyncOverrideForTests(() => {
      throw new Error('boom: no shell available')
    })
    const failed = getHostBaseEnv()
    expect(failed.PATH).toBe(FALLBACK_PATH)

    setSpawnSyncOverrideForTests(() => ({
      exitCode: 0,
      stdout: Buffer.from(`__FICUS_ENV__\0PATH=/ok/bin\0HOME=${home}\0`),
      stderr: Buffer.from(''),
    }))
    const succeeded = getHostBaseEnv()
    expect(succeeded.PATH).toBe('/ok/bin')

    // A subsequent failing spawnSync must never be invoked: the success above is now cached.
    setSpawnSyncOverrideForTests(() => {
      throw new Error('should not be called — a successful snapshot must already be cached')
    })
    const cached = getHostBaseEnv()
    expect(cached).toEqual(succeeded)
    expect(cached).not.toBe(succeeded)
  })

  test('ensureCliShim writes an executable shim that execs bun with the CLI path', () => {
    const cli = join(home, 'ficus.js')
    writeFileSync(cli, '')
    const shim = ensureCliShim({ cliHostPath: cli, bunPath: '/opt/bun' })
    expect(shim).toBe(join(hostBinDir(), 'ficus'))
    expect(statSync(shim!).mode & 0o777).toBe(0o755)
    const body = readFileSync(shim!, 'utf8')
    expect(body).toContain('#!/bin/sh')
    expect(body).toContain(`exec '/opt/bun' '${cli}' "$@"`)
  })

  test('ensureCliShim escapes single quotes in interpolated paths', () => {
    const cli = join(home, "weird'cli.js")
    writeFileSync(cli, '')
    const shim = ensureCliShim({ cliHostPath: cli, bunPath: "/opt/it's/bun" })
    const body = readFileSync(shim!, 'utf8')
    expect(body).toContain(`exec '/opt/it'\\''s/bun' '${home}/weird'\\''cli.js' "$@"`)
  })

  test('ensureCliShim returns null and writes nothing when the CLI build is missing', () => {
    expect(ensureCliShim({ cliHostPath: join(home, 'missing.js') })).toBeNull()
    expect(existsSync(join(hostBinDir(), 'ficus'))).toBe(false)
  })

  test('ensureCliShim writes only `ficus`, pointing at the absolute ficus.js, and never touches an older wrapper', () => {
    const cliDir = join(home, 'checkout', 'apps', 'cli', 'dist')
    mkdirSync(cliDir, { recursive: true })
    const cli = join(cliDir, 'ficus.js')
    writeFileSync(cli, '')
    // A wrapper an older Core left behind (it points at a build that no longer exists).
    mkdirSync(hostBinDir(), { recursive: true })
    const older = join(hostBinDir(), 'tau')
    const olderBody = '#!/bin/sh\nexec /old/bun /old/checkout/apps/cli/dist/old.js "$@"\n'
    writeFileSync(older, olderBody)
    chmodSync(older, 0o755)
    const olderStat = statSync(older)

    // Twice: the refresh path must leave the older wrapper alone too.
    ensureCliShim({ cliHostPath: cli, bunPath: '/opt/bun' })
    const shim = ensureCliShim({ cliHostPath: cli, bunPath: '/opt/bun' })

    expect(shim).toBe(join(hostBinDir(), 'ficus'))
    expect(readdirSync(hostBinDir()).sort()).toEqual(['ficus', 'tau'])
    const body = readFileSync(shim!, 'utf8')
    expect(body).toBe(`#!/bin/sh\nexec '/opt/bun' '${cli}' "$@"\n`)
    expect(cli.startsWith('/')).toBe(true)
    expect(readFileSync(older, 'utf8')).toBe(olderBody)
    const after = statSync(older)
    expect(after.ino).toBe(olderStat.ino)
    expect(after.mtimeMs).toBe(olderStat.mtimeMs)
    expect(after.mode).toBe(olderStat.mode)
  })

  test('ensureCliShim creates no other file when the CLI build is missing, even with an older wrapper present', () => {
    mkdirSync(hostBinDir(), { recursive: true })
    writeFileSync(join(hostBinDir(), 'tau'), 'old')
    expect(ensureCliShim({ cliHostPath: join(home, 'missing.js') })).toBeNull()
    expect(readdirSync(hostBinDir())).toEqual(['tau'])
    expect(readFileSync(join(hostBinDir(), 'tau'), 'utf8')).toBe('old')
  })

  test('resolveHostApiUrl uses PORT', () => {
    const prev = process.env.PORT
    process.env.PORT = '4444'
    try {
      expect(resolveHostApiUrl()).toBe('http://127.0.0.1:4444')
    } finally {
      if (prev === undefined) delete process.env.PORT
      else process.env.PORT = prev
    }
  })

  test('buildHostCommandEnv layers ficus vars, shim PATH and squad ssh config on the base', () => {
    mkdirSync(join(home, 'ssh', SQUAD), { recursive: true })
    writeFileSync(join(home, 'ssh', SQUAD, 'config'), '')
    const env = buildHostCommandEnv({ base: { PATH: '/bin', HOME: home }, ficusToken: 'tok', squadId: SQUAD })
    expect(env.PATH).toBe(`${hostBinDir()}:/bin`)
    expect(env.FICUS_TOKEN).toBe('tok')
    expect(env.FICUS_API_URL).toBe(resolveHostApiUrl())
    expect(env.GIT_SSH_COMMAND).toBe(`ssh -F '${join(home, 'ssh', SQUAD, 'config')}'`)
    expect(env.FICUS_SQUAD_SSH_DIR).toBe(join(home, 'ssh', SQUAD))
    expect(env.HOME).toBe(home)
  })

  test('buildHostCommandEnv pins the squad known_hosts when the squad has one', () => {
    // On host, ssh would otherwise write host keys into the OPERATOR's
    // ~/.ssh/known_hosts and ignore the squad's own file.
    mkdirSync(join(home, 'ssh', SQUAD), { recursive: true })
    writeFileSync(join(home, 'ssh', SQUAD, 'config'), '')
    writeFileSync(join(home, 'ssh', SQUAD, 'known_hosts'), '')
    const env = buildHostCommandEnv({ base: { PATH: '/bin' }, squadId: SQUAD })
    expect(env.GIT_SSH_COMMAND).toBe(
      `ssh -F '${join(home, 'ssh', SQUAD, 'config')}' -o UserKnownHostsFile='${join(home, 'ssh', SQUAD, 'known_hosts')}'`
    )
  })

  test('buildHostCommandEnv omits GIT_SSH_COMMAND and FICUS_TOKEN when absent', () => {
    const env = buildHostCommandEnv({ base: { PATH: '/bin' } })
    expect(env.GIT_SSH_COMMAND).toBeUndefined()
    expect(env.FICUS_TOKEN).toBeUndefined()
    expect(env.FICUS_SQUAD_SSH_DIR).toBeUndefined()
  })

  test('buildHostCommandEnv omits GIT_SSH_COMMAND when the squad has no ssh config yet', () => {
    const env = buildHostCommandEnv({ base: { PATH: '/bin' }, squadId: SQUAD })
    expect(env.GIT_SSH_COMMAND).toBeUndefined()
    expect(env.FICUS_SQUAD_SSH_DIR).toBeUndefined()
  })

  test('buildHostCommandEnv passes through APP_URL when set', () => {
    const prev = process.env.APP_URL
    process.env.APP_URL = 'https://example.test'
    try {
      const env = buildHostCommandEnv({ base: { PATH: '/bin' } })
      expect(env.APP_URL).toBe('https://example.test')
    } finally {
      if (prev === undefined) delete process.env.APP_URL
      else process.env.APP_URL = prev
    }
  })

  test('buildHostCommandEnv never leaks worker secrets, even through the real cached base env', () => {
    const prevDb = process.env.DATABASE_URL
    const prevAnthropic = process.env.ANTHROPIC_API_KEY
    const prevCallback = process.env.SANDBOX_CALLBACK_SECRET
    process.env.DATABASE_URL = 'postgres://leak'
    process.env.ANTHROPIC_API_KEY = 'leak-key'
    process.env.SANDBOX_CALLBACK_SECRET = 'leak-secret'
    resetHostBaseEnvCache()
    try {
      const env = buildHostCommandEnv({ ficusToken: 'tok' })
      expect(env.DATABASE_URL).toBeUndefined()
      expect(env.ANTHROPIC_API_KEY).toBeUndefined()
      expect(env.SANDBOX_CALLBACK_SECRET).toBeUndefined()
      expect(env.FICUS_TOKEN).toBe('tok')
    } finally {
      if (prevDb === undefined) delete process.env.DATABASE_URL
      else process.env.DATABASE_URL = prevDb
      if (prevAnthropic === undefined) delete process.env.ANTHROPIC_API_KEY
      else process.env.ANTHROPIC_API_KEY = prevAnthropic
      if (prevCallback === undefined) delete process.env.SANDBOX_CALLBACK_SECRET
      else process.env.SANDBOX_CALLBACK_SECRET = prevCallback
      resetHostBaseEnvCache()
    }
  })

  test('buildHostCommandEnv gives each agent its own CLI auth store and marks the shell as an agent', () => {
    const env = buildHostCommandEnv({ base: { PATH: '/bin' }, ficusToken: 'tok', agentId: 'agent-1' })
    expect(env.FICUS_AUTH_STORE).toBe(join(home, 'host', 'cli-auth', 'agent-1.json'))
    // A missing store reads as empty: the operator's ~/.tau/cli/auth.json is never the fallback.
    expect(existsSync(env.FICUS_AUTH_STORE!)).toBe(false)
    expect(env.FICUS_AGENT_CONTEXT).toBe('1')
    expect(env.FICUS_AGENT_ID).toBe('agent-1')
  })

  test('buildHostCommandEnv uses the anonymous store for a tokened shell with no agent id', () => {
    const env = buildHostCommandEnv({ base: { PATH: '/bin' }, ficusToken: 'tok', squadId: SQUAD })
    expect(env.FICUS_AUTH_STORE).toBe(join(home, 'host', 'cli-auth', 'anonymous.json'))
    expect(env.FICUS_AGENT_CONTEXT).toBe('1')
    expect(env.FICUS_AGENT_ID).toBeUndefined()
  })

  test('buildHostCommandEnv leaves an operator shell (no injected token) exactly as it was', () => {
    // Web terminals and `exec` get no token: overriding their auth store would
    // only break the human's own `ficus`, and protects nothing.
    const env = buildHostCommandEnv({ base: { PATH: '/bin' }, squadId: SQUAD, agentId: 'agent-1' })
    expect(env.FICUS_AUTH_STORE).toBeUndefined()
    expect(env.FICUS_AGENT_CONTEXT).toBeUndefined()
    expect(env.FICUS_AGENT_ID).toBeUndefined()
    expect(env.FICUS_API_URL).toBe(resolveHostApiUrl())
  })

  test('buildHostCommandEnv ignores a malformed agent id rather than building a path from it', () => {
    const env = buildHostCommandEnv({ base: { PATH: '/bin' }, ficusToken: 'tok', agentId: '../../etc/passwd' })
    expect(env.FICUS_AUTH_STORE).toBe(join(home, 'host', 'cli-auth', 'anonymous.json'))
    expect(env.FICUS_AGENT_ID).toBeUndefined()
  })

  test('buildHostCommandEnv passes the identity through the FICUS_IDENTITY_* aliases too', () => {
    const env = buildHostCommandEnv({ base: { PATH: '/bin' }, ficusToken: 'tok', agentId: 'agent-1' })
    expect(env.FICUS_IDENTITY_API_URL).toBe(resolveHostApiUrl())
    expect(env.FICUS_IDENTITY_TOKEN).toBe('tok')
    expect(env.FICUS_IDENTITY_AUTH_STORE).toBe(join(home, 'host', 'cli-auth', 'agent-1.json'))
    expect(env.FICUS_IDENTITY_AGENT_ID).toBe('agent-1')
  })

  test('buildHostCommandEnv aliases mirror only the names it actually set', () => {
    const env = buildHostCommandEnv({ base: { PATH: '/bin' } })
    expect(env.FICUS_IDENTITY_TOKEN).toBeUndefined()
    expect(env.FICUS_IDENTITY_AUTH_STORE).toBeUndefined()
    expect(env.FICUS_IDENTITY_AGENT_ID).toBeUndefined()
    expect(env.FICUS_IDENTITY_API_URL).toBe(resolveHostApiUrl())
  })

  /** The snapshot names carry a per-command random suffix, so tests read them back. */
  function snapshotNames(preamble: string): Record<string, string> {
    const names: Record<string, string> = {}
    for (const [, name, suffix] of preamble.matchAll(/(__ficus_[0-9a-f]{6}_(url|bin|tok|store|agent))\b/g)) {
      names[suffix] = name
    }
    return names
  }

  test('buildHostPreamble snapshots the identity BEFORE sourcing, then re-asserts it from the snapshots', () => {
    const pre = buildHostPreamble({ squadId: SQUAD, ficusToken: 'tok', agentId: 'agent-1' })
    const envPath = join(home, 'workspaces', 'squads', SQUAD, '.ficus', '.env')
    const names = snapshotNames(pre)
    const snapshotIndex = pre.indexOf(`${names.url}="$FICUS_IDENTITY_API_URL"`)
    const sourceIndex = pre.indexOf(`. "${envPath}"`)
    const exportIndex = pre.indexOf(`export FICUS_API_URL="$${names.url}"`)
    // The aliases are ordinary variables, so a squad env can overwrite THEM too:
    // reading them after the source line is exactly the bug this ordering closes.
    expect(snapshotIndex).toBeGreaterThanOrEqual(0)
    expect(sourceIndex).toBeGreaterThan(snapshotIndex)
    expect(exportIndex).toBeGreaterThan(sourceIndex)
    expect(pre).toContain(`FICUS_TOKEN="$${names.tok}"`)
    expect(pre).toContain(`FICUS_AUTH_STORE="$${names.store}"`)
    expect(pre).toContain('FICUS_AGENT_CONTEXT="1"')
    expect(pre).toContain(`FICUS_AGENT_ID="$${names.agent}"`)
    expect(pre.indexOf(`unset ${names.url}`)).toBeGreaterThan(exportIndex)
    expect(pre).toContain(
      'FICUS_IDENTITY_API_URL FICUS_IDENTITY_TOKEN FICUS_IDENTITY_AUTH_STORE FICUS_IDENTITY_AGENT_ID'
    )
  })

  test('buildHostPreamble uses fresh snapshot names on every command', () => {
    // A squad env cannot assign a name it cannot predict — which closes the
    // accidental/stale-variable case the fixed names left open.
    const first = snapshotNames(buildHostPreamble({ squadId: SQUAD, ficusToken: 'tok', agentId: 'agent-1' }))
    const second = snapshotNames(buildHostPreamble({ squadId: SQUAD, ficusToken: 'tok', agentId: 'agent-1' }))
    for (const key of ['url', 'bin', 'tok', 'store', 'agent']) {
      expect(first[key]).toBeDefined()
      expect(second[key]).not.toBe(first[key])
    }
  })

  test('buildHostPreamble re-asserts the shim PATH after sourcing, keeping what the squad env added', () => {
    const pre = buildHostPreamble({ squadId: SQUAD, ficusToken: 'tok', agentId: 'agent-1' })
    const envPath = join(home, 'workspaces', 'squads', SQUAD, '.ficus', '.env')
    const names = snapshotNames(pre)
    // `$PATH` is kept, so a squad env's own additions survive behind the shim dir.
    const pathIndex = pre.indexOf(`export PATH="$${names.bin}:$PATH"`)
    expect(pathIndex).toBeGreaterThan(pre.indexOf(`. "${envPath}"`))
    // The dir is snapshotted before sourcing too, so the squad env cannot move it.
    expect(pre).toContain(`${names.bin}='${hostBinDir()}'`)
    expect(pre.indexOf(`${names.bin}=`)).toBeLessThan(pre.indexOf(`. "${envPath}"`))
  })

  test('buildHostPreamble unsets every identity name it was not given', () => {
    // A stale squad env must not be able to hand a credential to a shell that has none.
    const pre = buildHostPreamble({ squadId: SQUAD })
    expect(pre).toContain('unset FICUS_TOKEN FICUS_AUTH_STORE FICUS_AGENT_CONTEXT FICUS_AGENT_ID')
    expect(pre).toContain(`export FICUS_API_URL="$${snapshotNames(pre).url}"`)
  })

  test('buildHostPreamble unsets the agent id when the shell has a token but no agent id', () => {
    const pre = buildHostPreamble({ squadId: SQUAD, ficusToken: 'tok' })
    expect(pre).toContain('unset FICUS_AGENT_ID')
    expect(pre).toContain(`FICUS_TOKEN="$${snapshotNames(pre).tok}"`)
  })

  test('buildHostPreamble never puts the token in the command string', () => {
    // argv is world-readable through /proc on Linux; the value travels in the env.
    const pre = buildHostPreamble({ squadId: SQUAD, ficusToken: 'super-secret-token', agentId: 'agent-1' })
    expect(pre).not.toContain('super-secret-token')
  })

  test('buildHostPreamble re-asserts the identity for a solo shell with no squad env to source', () => {
    const pre = buildHostPreamble({ ficusToken: 'tok', agentId: 'agent-1' })
    const names = snapshotNames(pre)
    expect(pre).not.toContain('set -a')
    expect(pre).toContain(`export FICUS_API_URL="$${names.url}"`)
    expect(pre).toContain(`FICUS_TOKEN="$${names.tok}"`)
    expect(pre).toContain(`export PATH="$${names.bin}:$PATH"`)
  })
})
