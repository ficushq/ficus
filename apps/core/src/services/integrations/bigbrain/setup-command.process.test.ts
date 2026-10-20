import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runBigbrainSetupCommand } from './setup-command'
import { createSyntheticBigbrain, createSyntheticVault, type SyntheticBigbrain } from './synthetic-upstream.fixture'

let root: string
let bigbrain: SyntheticBigbrain
let vault: string
const previousEnv = { ...process.env }
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'bigbrain-setup-command-')))
  const osHome = join(root, 'Users', 'Synthetic Mac')
  bigbrain = await createSyntheticBigbrain(root, osHome)
  vault = await createSyntheticVault(join(osHome, 'My Vault'))
  Object.assign(process.env, { HOME: osHome, FICUS_TOKEN: 'must-not-forward', BIGBRAIN_TOKENS: '/must-not-inherit' })
})
afterEach(async () => {
  process.env = { ...previousEnv }
  await rm(root, { recursive: true, force: true })
})

test('runs fixed `mcp config` argv with a restricted env and returns only the client ID', async () => {
  const first = await runBigbrainSetupCommand({ executablePath: bigbrain.executable, vaultPath: vault })
  expect(first.clientId).toMatch(/^[a-f0-9]{8}$/)
  const second = await runBigbrainSetupCommand({ executablePath: bigbrain.executable, vaultPath: vault })
  expect(second).toEqual(first) // upstream ensure() reuses the named connection
  const launches = await bigbrain.launches()
  expect(launches.filter((entry) => 'minted' in entry)).toHaveLength(1)
  for (const launch of launches.filter((entry) => 'args' in entry)) {
    expect(launch.args).toEqual(['mcp', 'config'])
    expect(launch).toMatchObject({ home: bigbrain.osHome, vault })
    expect(launch.tokens).toBeUndefined()
    expect(launch.coreSecret).toBeUndefined()
    expect(String(launch.cwd)).toContain('ficus-bigbrain-setup-')
  }
  // The private working directory is removed afterwards.
  expect(existsSync(String(launches[0]!.cwd))).toBe(false)
})

test('vault names with shell metacharacters stay data: no shell, nothing is executed', async () => {
  const marker = join(root, 'pwned')
  for (const name of [
    `$(touch ${marker})`,
    `'; touch ${marker}; '`,
    '`touch pwned`',
    'a" && touch pwned "b',
    '--client=deadbeef',
  ]) {
    const path = await createSyntheticVault(join(root, 'vaults', name.replaceAll('/', '_')))
    const result = await runBigbrainSetupCommand({ executablePath: bigbrain.executable, vaultPath: path })
    expect(result.clientId).toMatch(/^[a-f0-9]{8}$/)
  }
  expect(existsSync(marker)).toBe(false)
  expect(existsSync(join(process.cwd(), 'pwned'))).toBe(false)
  for (const launch of (await bigbrain.launches()).filter((entry) => 'args' in entry))
    expect(launch.args).toEqual(['mcp', 'config'])
})

test('failures map to fixed codes and never carry upstream output', async () => {
  for (const [mode, code] of [
    ['fail', 'failed'],
    ['revoked', 'connection_revoked'],
    ['garbage', 'invalid_output'],
    ['big', 'invalid_output'],
    ['wrong-vault', 'invalid_output'],
  ] as const) {
    await bigbrain.setMode(mode)
    const error = await runBigbrainSetupCommand({ executablePath: bigbrain.executable, vaultPath: vault }).catch(
      (e) => e
    )
    expect(error).toMatchObject({ name: 'BigbrainSetupCommandError', code })
    expect(JSON.stringify({ message: error.message, ...error })).not.toMatch(/SECRET|Bearer|private\/path/)
  }
  await expect(
    runBigbrainSetupCommand({ executablePath: join(root, 'missing'), vaultPath: vault })
  ).rejects.toMatchObject({ code: 'executable_missing' })
})

test('a hung command and its children are killed at the deadline; one setup runs at a time', async () => {
  await bigbrain.setMode('spawn-child')
  const started = Date.now()
  const pending = runBigbrainSetupCommand({ executablePath: bigbrain.executable, vaultPath: vault, deadlineMs: 800 })
  await expect(
    runBigbrainSetupCommand({ executablePath: bigbrain.executable, vaultPath: vault })
  ).rejects.toMatchObject({ code: 'busy' })
  await expect(pending).rejects.toMatchObject({ code: 'timeout' })
  expect(Date.now() - started).toBeLessThan(5000)
  await bigbrain.setMode('ok')
  await expect(runBigbrainSetupCommand({ executablePath: bigbrain.executable, vaultPath: vault })).resolves.toEqual({
    clientId: expect.stringMatching(/^[a-f0-9]{8}$/),
  })
}, 15000)
