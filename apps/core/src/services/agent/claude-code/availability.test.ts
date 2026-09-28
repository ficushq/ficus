import { afterAll, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
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

test('never offered on Ficus Cloud, even when turned on', async () => {
  const status = await getClaudeCodeStatus({ env: { ...local, FICUS_MANAGED: '1' }, run: signedIn, enabled: true })
  expect(status).toMatchObject({ offered: false, enabled: false, loggedIn: false })
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
  expect(Object.keys(env).sort()).toEqual(['HOME', 'PATH'])
})
