import { afterEach, beforeEach, expect, test } from 'bun:test'
import { randomBytes } from 'node:crypto'
import {
  createAssistantMessageEventStream,
  normalizeContext,
  type Api,
  type AssistantMessageEventStream,
  type Model,
} from '@earendil-works/pi-ai'
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic'
import { db, secrets } from '../../../db'
import { getSecretStore, resetSecretStore } from '../../secrets'
import { addAccount, listAccounts, mutateAccountStore, readAccountStore } from '../account-store'
import { selectAccount } from '../account-selection'
import { CLAUDE_CODE_ACCOUNT_ID, setClaudeCodeAccountEnabled } from './account'
import { anthropicWithClaudeCode } from './anthropic'
import { primeClaudeCodeStatus, setClaudeCodeStatusForTests, type RunClaude } from './availability'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const signedIn = { offered: true, enabled: true, loggedIn: true, executable: '/usr/local/bin/claude' }
const signedOut = { offered: true, enabled: true, loggedIn: false, reason: 'Claude Code is not signed in' }
const healthy = { isAccountHealthy: () => true }

let previousKey: string | undefined
beforeEach(async () => {
  previousKey = process.env.FICUS_ENCRYPTION_KEY
  process.env.FICUS_ENCRYPTION_KEY = randomBytes(32).toString('hex')
  await db.delete(secrets)
  resetSecretStore()
  await getSecretStore().initialize()
})
afterEach(() => {
  getSecretStore().stopPeriodicRefresh()
  if (previousKey === undefined) delete process.env.FICUS_ENCRYPTION_KEY
  else process.env.FICUS_ENCRYPTION_KEY = previousKey
  setClaudeCodeStatusForTests(undefined)
})

test('turning Claude Code on adds it as the first Anthropic account, before any API key', async () => {
  await mutateAccountStore((store) => {
    addAccount(store, 'anthropic', { type: 'api_key', key: 'sk-ant-api03-key' }, 'Work key')
  }, 'admin')
  await setClaudeCodeAccountEnabled(true, 'admin')
  const accounts = listAccounts(readAccountStore(), 'anthropic')
  expect(accounts.map((account) => account.id)[0]).toBe(CLAUDE_CODE_ACCOUNT_ID)
  expect(accounts[0]).toMatchObject({ kind: 'claude-code', enabled: true, credential: { type: 'api_key' } })
  // No credential of its own: only the marker.
  expect((accounts[0]!.credential as { key?: string }).key).toBeUndefined()

  await setClaudeCodeAccountEnabled(false, 'admin')
  expect(listAccounts(readAccountStore(), 'anthropic')[0]).toMatchObject({ id: CLAUDE_CODE_ACCOUNT_ID, enabled: false })
})

test('account selection uses Claude Code while signed in and fails over to the API key when not', async () => {
  await mutateAccountStore((store) => {
    addAccount(store, 'anthropic', { type: 'api_key', key: 'sk-ant-api03-key' })
  }, 'admin')
  await setClaudeCodeAccountEnabled(true, 'admin')

  setClaudeCodeStatusForTests(signedIn)
  expect(selectAccount('anthropic', readAccountStore(), healthy)?.id).toBe(CLAUDE_CODE_ACCOUNT_ID)

  setClaudeCodeStatusForTests(signedOut)
  expect(selectAccount('anthropic', readAccountStore(), healthy)?.kind).toBeUndefined()

  // An exhausted Claude Code (plan limit reached) also fails over.
  setClaudeCodeStatusForTests(signedIn)
  const exhausted = { isAccountHealthy: (_provider: string, id: string) => id !== CLAUDE_CODE_ACCOUNT_ID }
  expect(selectAccount('anthropic', readAccountStore(), exhausted)?.kind).toBeUndefined()
})

test('an agent start waits for the sign-in status, so the first selection after boot uses Claude Code', async () => {
  await mutateAccountStore((store) => {
    addAccount(store, 'anthropic', { type: 'api_key', key: 'sk-ant-api03-key' })
  }, 'admin')
  await setClaudeCodeAccountEnabled(true, 'admin')
  // Nothing cached yet, as in a freshly started worker: selection alone cannot see Claude Code.
  setClaudeCodeStatusForTests(undefined)
  expect(selectAccount('anthropic', readAccountStore(), healthy)?.kind).toBeUndefined()

  const bin = mkdtempSync(join(tmpdir(), 'claude-code-bin-'))
  try {
    writeFileSync(join(bin, 'claude'), '#!/bin/sh\nexit 0\n')
    chmodSync(join(bin, 'claude'), 0o755)
    const run: RunClaude = async (_executable, args) => ({
      exitCode: 0,
      stdout: args[0] === '--version' ? '2.1.281' : JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' }),
    })
    await primeClaudeCodeStatus({ env: { PATH: bin, HOME: '/nonexistent' }, run })
    expect(selectAccount('anthropic', readAccountStore(), healthy)?.id).toBe(CLAUDE_CODE_ACCOUNT_ID)
  } finally {
    rmSync(bin, { recursive: true, force: true })
  }
})

test('the Anthropic provider sends only Claude Code account turns through the bridge', async () => {
  setClaudeCodeStatusForTests(signedIn)
  const base = anthropicProvider()
  const bridged: string[] = []
  const bridge = (model: Model<Api>): AssistantMessageEventStream => {
    bridged.push(model.id)
    return createAssistantMessageEventStream()
  }
  const provider = anthropicWithClaudeCode(base, bridge)
  const signal = new AbortController().signal
  const ctx = { env: async () => undefined }

  const viaClaudeCode = await provider.auth.apiKey!.resolve({
    ctx,
    credential: { type: 'api_key', env: { FICUS_CLAUDE_CODE: '1' } },
    signal,
  } as never)
  expect(viaClaudeCode).toEqual({ auth: {}, env: { FICUS_CLAUDE_CODE: '1' }, source: 'Claude Code' })
  // A normal API key account resolves exactly as before.
  expect(
    (
      await provider.auth.apiKey!.resolve({
        ctx,
        credential: { type: 'api_key', key: 'sk-ant-api03-k' },
        signal,
      } as never)
    )?.auth
  ).toEqual({ apiKey: 'sk-ant-api03-k' })

  const model = base.getModels().find((candidate) => candidate.id === 'claude-opus-5-5')!
  const context = normalizeContext({ messages: [{ role: 'user', content: 'hi', timestamp: Date.now() }] })
  provider.streamSimple(model, context, { env: { FICUS_CLAUDE_CODE: '1' } })
  expect(bridged).toEqual(['claude-opus-5-5'])

  // Signed out: the account does not resolve, so pi reports the provider unconfigured for it.
  setClaudeCodeStatusForTests(signedOut)
  expect(
    await provider.auth.apiKey!.resolve({
      ctx,
      credential: { type: 'api_key', env: { FICUS_CLAUDE_CODE: '1' } },
      signal,
    } as never)
  ).toBeUndefined()
})
