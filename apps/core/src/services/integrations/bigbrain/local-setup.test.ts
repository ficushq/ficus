import { afterEach, beforeEach, expect, test } from 'bun:test'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SafeIntegrationConnection } from '../connection-service'
import type { IntegrationConnectionRecord } from '../connection-repository'
import { BigbrainBindings } from './local-bindings'
import { BigbrainLocalSetup, vaultSelectionId } from './local-setup'
import { runBigbrainSetupCommand } from './setup-command'
import { createSyntheticBigbrain, createSyntheticVault, type SyntheticBigbrain } from './synthetic-upstream.fixture'

let root: string
let home: string
let osHome: string
let vault: string
let bigbrain: SyntheticBigbrain
let available: boolean
let records: IntegrationConnectionRecord[]
let calls: string[]
const previousEnv = { ...process.env }

function view(record: IntegrationConnectionRecord): SafeIntegrationConnection {
  return {
    id: record.id,
    providerKey: 'bigbrain',
    adapterVersion: 2,
    displayName: record.displayName,
    configuration: record.configuration,
    credentialConfigured: true,
    enabled: record.enabled,
    authState: 'authenticated',
    healthState: 'healthy',
    grantedScopes: [],
    validatedAt: null,
    validationExpiresAt: null,
    lastErrorCode: null,
    usage: { squadCount: 0, squads: [] },
  }
}
function setup(options: { command?: typeof runBigbrainSetupCommand } = {}) {
  const bindings = new BigbrainBindings({ home, osHome, supported: () => available })
  const find = (id: string) => records.find((record) => record.id === id)!
  return new BigbrainLocalSetup(
    bindings,
    {
      create: async (input) => {
        calls.push('create')
        const record = {
          id: `connection-${records.length + 1}`,
          providerKey: 'bigbrain',
          displayName: input.displayName,
          configuration: input.configuration,
          enabled: false,
          credential: input.credential,
        } as unknown as IntegrationConnectionRecord
        records.push(record)
        return view(record)
      },
      replaceCredential: async (id, credential, _actor, _confirm, configuration) => {
        calls.push('replace')
        Object.assign(find(id), { configuration, credential, enabled: false })
        return view(find(id))
      },
      enable: async (id) => {
        calls.push('enable')
        find(id).enabled = true
        return view(find(id))
      },
      validate: async (id) => {
        calls.push('validate')
        return view(find(id))
      },
      safeView: async (record) => view(record),
    },
    {
      list: async () => records,
      get: async (id) => records.find((record) => record.id === id) ?? null,
    },
    { home, osHome, availability: () => ({ available, reason: 'Unavailable on Ficus Cloud.' }), ...options }
  )
}
const bindingsFile = () => join(home, 'bigbrain-bindings.json')
const readBindings = async () => JSON.parse(await readFile(bindingsFile(), 'utf8'))

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'bigbrain-local-setup-')))
  home = join(root, 'Ficus Home')
  osHome = join(root, 'Users', 'Synthetic Mac')
  await mkdir(home, { recursive: true, mode: 0o700 })
  bigbrain = await createSyntheticBigbrain(root, osHome)
  vault = await createSyntheticVault(join(osHome, 'Brain Vault'))
  await mkdir(join(osHome, '.config', 'bigbrain'), { recursive: true, mode: 0o700 })
  await writeFile(join(osHome, '.config', 'bigbrain', 'vault'), vault + '\n', { mode: 0o600 })
  Object.assign(process.env, { HOME: osHome })
  available = true
  records = []
  calls = []
})
afterEach(async () => {
  process.env = { ...previousEnv }
  await rm(root, { recursive: true, force: true })
})

test('detects the bigbrain command and BigBrain default vault on the Core host', async () => {
  const state = await setup().state()
  expect(state).toMatchObject({
    state: 'ready',
    executablePath: bigbrain.executable,
    bindingsFile: 'none',
    connectionName: 'Local MCP configuration',
    access: ['vault:read', 'inbox:write'],
    vaults: [
      { id: vaultSelectionId(vault), vaultPath: vault, source: 'bigbrain_default', label: 'BigBrain · Brain Vault' },
    ],
  })
  // Without a pointer BigBrain.app opens ~/vault.
  await rm(join(osHome, '.config', 'bigbrain', 'vault'))
  expect((await setup().state()).vaults).toEqual([])
  const fallback = await createSyntheticVault(join(osHome, 'vault'))
  expect((await setup().state()).vaults).toMatchObject([{ vaultPath: fallback, source: 'bigbrain_fallback' }])
})

test('reports a missing or unsafe command and refuses unsupported deployments', async () => {
  await chmod(join(osHome, '.local', 'bin'), 0o777)
  expect((await setup().state()).state).toBe('executable_untrusted')
  await chmod(join(osHome, '.local', 'bin'), 0o700)
  await rm(bigbrain.executable)
  const missing = await setup().state()
  expect(missing).toMatchObject({ state: 'executable_missing' })
  expect(missing.reason).toContain('Install and open BigBrain.app')
  available = false
  expect(await setup().state()).toMatchObject({ state: 'unsupported_host', reason: 'Unavailable on Ficus Cloud.' })
  await expect(
    setup().connect({ vaultId: vaultSelectionId(vault), confirmVaultAccess: true }, 'user:u')
  ).rejects.toMatchObject({ code: 'unsupported_host' })
})

test('one action creates the connection, writes a private managed file, enables; repeat is idempotent', async () => {
  const first = await setup().connect({ vaultId: vaultSelectionId(vault), confirmVaultAccess: true }, 'user:u')
  expect(first).toMatchObject({ bindingsFile: 'created', connectionOutcome: 'created', enabled: true })
  expect(calls).toEqual(['create', 'enable'])
  expect((await stat(bindingsFile())).mode & 0o777).toBe(0o600)
  const file = await readBindings()
  expect(file).toEqual({
    version: 1,
    managedBy: 'ficus',
    bindings: [
      {
        id: expect.stringMatching(/^vault-[a-f0-9]{12}$/),
        label: 'BigBrain · Brain Vault',
        vaultPath: vault,
        executablePath: bigbrain.executable,
        clientId: expect.stringMatching(/^[a-f0-9]{8}$/),
      },
    ],
  })
  expect(JSON.stringify(file)).not.toContain('synthetic-not-a-secret')
  calls = []
  const second = await setup().connect({ vaultId: vaultSelectionId(vault), confirmVaultAccess: true }, 'user:u')
  expect(second).toMatchObject({ bindingsFile: 'unchanged', connectionOutcome: 'reused', enabled: true })
  expect(second.connection.id).toBe(first.connection.id)
  expect(calls).toEqual(['validate'])
  expect(records).toHaveLength(1)
  expect((await bigbrain.launches()).filter((entry) => 'minted' in entry)).toHaveLength(1)
})

test('a changed BigBrain client re-pins the same Ficus connection in place', async () => {
  const first = await setup().connect({ vaultId: vaultSelectionId(vault), confirmVaultAccess: true }, 'user:u')
  calls = []
  const changed = setup({ command: async () => ({ clientId: 'cafe0123' }) })
  const store = join(
    osHome,
    '.config',
    'bigbrain',
    'tokens',
    new Bun.CryptoHasher('sha256').update(vault).digest('hex').slice(0, 12) + '.json.clients'
  )
  await writeFile(join(store, 'cafe0123.json'), '{}', { mode: 0o600 })
  const result = await changed.connect({ vaultId: vaultSelectionId(vault), confirmVaultAccess: true }, 'user:u')
  expect(result).toMatchObject({ bindingsFile: 'updated', connectionOutcome: 'updated', enabled: true })
  expect(result.connection.id).toBe(first.connection.id)
  expect(calls).toEqual(['replace', 'enable'])
  expect((await readBindings()).bindings[0].clientId).toBe('cafe0123')
})

test('an existing hand-written or unreadable file is only adopted with confirmation', async () => {
  const other = await createSyntheticVault(join(root, 'Other Vault'))
  const handWritten = {
    version: 1,
    bindings: [
      { id: 'personal', label: 'Mine', vaultPath: other, executablePath: bigbrain.executable, clientId: 'aabb0011' },
    ],
  }
  await writeFile(bindingsFile(), JSON.stringify(handWritten), { mode: 0o600 })
  const state = await setup().state()
  expect(state.bindingsFile).toBe('unmanaged')
  expect(state.vaults.map((v) => v.source)).toEqual(['bigbrain_default', 'existing_binding'])
  await expect(
    setup().connect({ vaultId: vaultSelectionId(vault), confirmVaultAccess: true }, 'user:u')
  ).rejects.toMatchObject({ code: 'confirmation_required' })
  expect(await bigbrain.launches()).toEqual([]) // refused before running BigBrain
  expect(JSON.parse(await readFile(bindingsFile(), 'utf8'))).toEqual(handWritten)
  await setup().connect({ vaultId: vaultSelectionId(vault), confirmVaultAccess: true, replaceExisting: true }, 'user:u')
  const adopted = await readBindings()
  expect(adopted.managedBy).toBe('ficus')
  expect(adopted.bindings.map((b: { id: string }) => b.id)).toEqual(['personal', expect.stringMatching(/^vault-/)])

  await writeFile(bindingsFile(), '{not json', { mode: 0o600 })
  expect((await setup().state()).bindingsFile).toBe('invalid')
  await expect(
    setup().connect({ vaultId: vaultSelectionId(vault), confirmVaultAccess: true }, 'user:u')
  ).rejects.toMatchObject({ code: 'confirmation_required' })
})

test('a typed Core-host folder is accepted only when it is a real private vault outside agent roots', async () => {
  const chosen = await createSyntheticVault(join(root, 'Elsewhere', 'Work Vault'))
  const result = await setup().connect({ vaultPath: chosen + '/', confirmVaultAccess: true }, 'user:u')
  expect(result.vault).toMatchObject({ vaultPath: chosen, source: 'chosen_folder' })
  for (const [path, code] of [
    ['relative/vault', 'vault_not_found'],
    [join(root, 'missing'), 'vault_not_found'],
    [root, 'vault_not_found'], // no vault.yaml
    [`${chosen}\n`, 'vault_not_found'],
  ] as const)
    await expect(setup().connect({ vaultPath: path, confirmVaultAccess: true }, 'user:u')).rejects.toMatchObject({
      code,
    })
  const exposed = await createSyntheticVault(join(home, 'workspaces', 'squad', 'vault'))
  await expect(setup().connect({ vaultPath: exposed, confirmVaultAccess: true }, 'user:u')).rejects.toMatchObject({
    code: 'vault_untrusted',
  })
  const shared = await createSyntheticVault(join(root, 'Shared Vault'))
  await chmod(shared, 0o777)
  await expect(setup().connect({ vaultPath: shared, confirmVaultAccess: true }, 'user:u')).rejects.toMatchObject({
    code: 'vault_untrusted',
  })
  await expect(setup().connect({ vaultId: 'f'.repeat(16), confirmVaultAccess: true }, 'user:u')).rejects.toMatchObject({
    code: 'vault_not_found',
  })
})

test('upstream failures surface fixed, sanitized messages', async () => {
  await bigbrain.setMode('revoked')
  const error = await setup()
    .connect({ vaultId: vaultSelectionId(vault), confirmVaultAccess: true }, 'user:u')
    .catch((e) => e)
  expect(error).toMatchObject({ code: 'upstream_connection_revoked' })
  expect(error.message).toContain('Connected Clients')
  expect(error.message).not.toContain('SECRET')
  expect(existsSync(bindingsFile())).toBe(false)
})

test('release drops a managed binding once no connection uses it, then the file', async () => {
  const local = setup()
  const { connection } = await local.connect({ vaultId: vaultSelectionId(vault), confirmVaultAccess: true }, 'user:u')
  const bindingId = (connection.configuration as { bindingId: string }).bindingId
  await local.release(bindingId)
  expect(existsSync(bindingsFile())).toBe(true) // still used
  records = []
  await local.release('personal') // never touches hand-declared IDs
  await local.release(bindingId)
  expect(existsSync(bindingsFile())).toBe(false)
})

test('a second vault with the same folder name gets a distinct display name', async () => {
  records.push({
    id: 'other',
    providerKey: 'bigbrain',
    displayName: 'BigBrain · Brain Vault',
    configuration: { version: 2, bindingId: 'vault-000000000000' },
    enabled: true,
  } as unknown as IntegrationConnectionRecord)
  const result = await setup().connect({ vaultId: vaultSelectionId(vault), confirmVaultAccess: true }, 'user:u')
  expect(result).toMatchObject({ connectionOutcome: 'created' })
  expect(result.connection.displayName).toBe('BigBrain · Brain Vault (2)')
})
