import { afterAll, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import { claudeChildEnv, getClaudeCodeStatus, type RunClaude } from './availability'

// A `claude` on PATH for Bun.which to find; the runner below answers for it.
const bin = mkdtempSync(join(tmpdir(), 'claude-code-bin-'))
writeFileSync(join(bin, 'claude'), '#!/bin/sh\nexit 0\n')
chmodSync(join(bin, 'claude'), 0o755)
afterAll(() => rmSync(bin, { recursive: true, force: true }))
const local = { PATH: bin, HOME: '/nonexistent' }

const signedIn: RunClaude = async (_executable, args) =>
  args[0] === '--version'
    ? { exitCode: 0, stdout: '2.1.281 (Claude Code)\n' }
    : {
        exitCode: 0,
        stdout: JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'max', email: 'x@y.z' }),
      }

test('not offered on Ficus Cloud, even when turned on', async () => {
  const status = await getClaudeCodeStatus({ env: { ...local, FICUS_MANAGED: '1' }, run: signedIn, enabled: true })
  expect(status).toMatchObject({ offered: false, enabled: false, loggedIn: false })
})

test('offered on a Ficus Cloud tenant the platform opts in with FICUS_CLAUDE_CODE=1', async () => {
  const status = await getClaudeCodeStatus({
    env: { ...local, FICUS_MANAGED: '1', FICUS_CLAUDE_CODE: '1' },
    run: signedIn,
    enabled: true,
  })
  expect(status).toMatchObject({ offered: true, enabled: true, loggedIn: true })
})

test('reports sign-in status without keeping anything else from the status output', async () => {
  const status = await getClaudeCodeStatus({ env: local, run: signedIn, enabled: true })
  expect(status).toEqual({
    offered: true,
    enabled: true,
    executable: join(bin, 'claude'),
    version: '2.1.281',
    loggedIn: true,
    authMethod: 'claude.ai',
    subscriptionType: 'max',
    candidates: [join(bin, 'claude')],
  })
})

test('off until the owner turns it on, and says why', async () => {
  expect(await getClaudeCodeStatus({ env: local, run: signedIn, enabled: false })).toMatchObject({
    offered: true,
    enabled: false,
    loggedIn: true,
    reason: 'Turned off',
  })
})

test('signed out, and not installed, are unavailable with a reason', async () => {
  const signedOut: RunClaude = async () => ({ exitCode: 1, stdout: JSON.stringify({ loggedIn: false }) })
  expect(await getClaudeCodeStatus({ env: local, run: signedOut, enabled: true })).toMatchObject({
    loggedIn: false,
    reason: 'Claude Code is not signed in',
  })
  expect(
    await getClaudeCodeStatus({ env: { PATH: '/nonexistent', HOME: '/nonexistent' }, run: signedIn, enabled: true })
  ).toMatchObject({ offered: true, loggedIn: false, reason: 'Claude Code is not installed' })
})

test("when claude can't say, the status shows its exit code and error instead of 'not signed in'", async () => {
  const crashed: RunClaude = async (_executable, args) =>
    args[0] === '--version'
      ? { exitCode: 0, stdout: '2.1.281 (Claude Code)\n' }
      : { exitCode: 127, stdout: '', stderr: 'env: node: No such file or directory\n' }
  expect(await getClaudeCodeStatus({ env: local, run: crashed, enabled: true })).toMatchObject({
    executable: join(bin, 'claude'),
    loggedIn: false,
    reason: "Could not read Claude Code's sign-in status",
    detail: 'exit 127: env: node: No such file or directory',
  })
  const garbled: RunClaude = async () => ({ exitCode: 0, stdout: 'Welcome to Claude Code!' })
  expect(await getClaudeCodeStatus({ env: local, run: garbled, enabled: true })).toMatchObject({
    loggedIn: false,
    detail: 'exit 0: Welcome to Claude Code!',
  })
  const silent: RunClaude = async () => ({ exitCode: 143, stdout: '' })
  expect(await getClaudeCodeStatus({ env: local, run: silent, enabled: true })).toMatchObject({
    detail: 'exit 143 with no output',
  })
  const threw: RunClaude = async () => {
    throw new Error('spawn EACCES')
  }
  expect(await getClaudeCodeStatus({ env: local, run: threw, enabled: true })).toMatchObject({
    reason: 'Could not run Claude Code',
    detail: 'spawn EACCES',
  })
})

test('with several installs, the newest claude is used', async () => {
  const older = mkdtempSync(join(tmpdir(), 'claude-code-old-'))
  const newer = mkdtempSync(join(tmpdir(), 'claude-code-new-'))
  try {
    for (const dir of [older, newer]) {
      writeFileSync(join(dir, 'claude'), '#!/bin/sh\nexit 0\n')
      chmodSync(join(dir, 'claude'), 0o755)
    }
    const run: RunClaude = async (executable, args) =>
      args[0] === '--version'
        ? { exitCode: 0, stdout: executable.startsWith(older) ? '2.1.221 (Claude Code)' : '2.1.284 (Claude Code)' }
        : { exitCode: 0, stdout: JSON.stringify({ loggedIn: true }) }
    // The older install comes first on PATH, as it can in a background worker's environment.
    const status = await getClaudeCodeStatus({
      env: { PATH: `${older}:${newer}`, HOME: '/nonexistent' },
      run,
      enabled: true,
    })
    expect(status).toMatchObject({ executable: join(newer, 'claude'), version: '2.1.284', loggedIn: true })
  } finally {
    rmSync(older, { recursive: true, force: true })
    rmSync(newer, { recursive: true, force: true })
  }
})

test("claude never inherits Core's secrets or an Anthropic API key", () => {
  const env = claudeChildEnv({
    HOME: '/Users/me',
    PATH: '/usr/bin',
    DATABASE_URL: 'postgres://secret',
    FICUS_ENCRYPTION_KEY: 'k',
    ANTHROPIC_API_KEY: 'sk-ant-api03-core',
    ANTHROPIC_BASE_URL: 'https://proxy',
  })
  expect(env.HOME).toBe('/Users/me')
  expect(Object.keys(env).sort()).toEqual(['HOME', 'LOGNAME', 'PATH', 'USER'])
})

test('claude gets USER even when Core was started without it, so it finds its Keychain sign-in', () => {
  expect(claudeChildEnv({ HOME: '/Users/me', PATH: '/usr/bin' })).toMatchObject({
    USER: userInfo().username,
    LOGNAME: userInfo().username,
  })
  expect(claudeChildEnv({ HOME: '/Users/me', PATH: '/usr/bin', USER: 'me' })).toMatchObject({
    USER: 'me',
    LOGNAME: 'me',
  })
})
