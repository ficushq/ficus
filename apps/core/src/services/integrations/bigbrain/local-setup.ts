import { getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js'
import { constants } from 'node:fs'
import { access, lstat, open, realpath, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { basename, isAbsolute, join } from 'node:path'
import { getHomeDir } from '../../../lib/utils/home'
import type { IntegrationConnectionService, SafeIntegrationConnection } from '../connection-service'
import type { IntegrationConnectionRecord } from '../connection-repository'
import { bigbrainHostAvailability } from './availability'
import { BigbrainError } from './errors'
import {
  agentExposedRoots,
  assertTrustedPath,
  overlapsAny,
  type BigbrainBindingDeclaration,
  type BigbrainBindings,
  type BigbrainBindingsFileState,
  type BigbrainConfigV2,
} from './local-bindings'
import { BigbrainSetupCommandError, runBigbrainSetupCommand } from './setup-command'

/** The named connection upstream `bigbrain mcp config` creates or reuses (ConnectedClients.ensure). */
export const BIGBRAIN_SETUP_CONNECTION_NAME = 'Local MCP configuration'
const MANAGED_ID_PREFIX = 'vault-'

export type BigbrainSetupErrorCode =
  | 'unsupported_host'
  | 'executable_missing'
  | 'executable_untrusted'
  | 'vault_not_found'
  | 'vault_untrusted'
  | 'confirmation_required'
  | 'busy'
  | 'upstream_timeout'
  | 'upstream_connection_revoked'
  | 'upstream_failed'
  | 'upstream_invalid_output'
  | 'credential_unavailable'
  | 'bindings_write_failed'
  | 'too_many_vaults'

const MESSAGES: Record<Exclude<BigbrainSetupErrorCode, 'unsupported_host'>, string> = {
  executable_missing:
    'BigBrain is not installed for the account that runs Ficus. Install and open BigBrain.app, then try again.',
  executable_untrusted:
    'The bigbrain command (~/.local/bin/bigbrain) is writable by other users or sits inside a Ficus agent folder. Reopen BigBrain.app so it reinstalls the command, then try again.',
  vault_not_found:
    'That folder is not a BigBrain vault on the Ficus host (it has no vault.yaml). Open BigBrain.app to create or choose a vault, then try again.',
  vault_untrusted:
    'That vault is writable by other users or sits inside a Ficus agent folder. Choose a private vault outside Ficus workspaces.',
  confirmation_required:
    'A bigbrain-bindings.json that Ficus did not create already exists. Confirm to let Ficus manage it.',
  busy: 'BigBrain setup is already running. Wait for it to finish, then try again.',
  upstream_timeout: 'BigBrain did not answer in time. Open BigBrain.app, then try again.',
  upstream_connection_revoked:
    'The "Local MCP configuration" connection was revoked in BigBrain. Reconnect it in BigBrain.app under Connected Clients, then try again.',
  upstream_failed: 'BigBrain could not set up its connection. Open BigBrain.app to check the vault, then try again.',
  upstream_invalid_output:
    'BigBrain returned a setup response Ficus does not recognize. Update BigBrain, then try again.',
  credential_unavailable:
    "BigBrain's private connection files for this vault are missing or readable by other users. Open BigBrain.app, then try again.",
  bindings_write_failed:
    'Ficus could not save its BigBrain settings file. Check that the Ficus data directory is private to your account.',
  too_many_vaults: 'Ficus can manage up to 32 BigBrain vaults. Remove an unused BigBrain connection first.',
}

export class BigbrainSetupError extends Error {
  constructor(
    readonly code: BigbrainSetupErrorCode,
    message = code === 'unsupported_host' ? 'BigBrain is unsupported here.' : MESSAGES[code]
  ) {
    super(message)
    this.name = 'BigbrainSetupError'
  }
}

export interface BigbrainSetupVault {
  /** Opaque selection handle; the vault itself is always re-detected server-side. */
  id: string
  label: string
  vaultPath: string
  source: 'bigbrain_default' | 'bigbrain_fallback' | 'existing_binding' | 'chosen_folder'
}
export interface BigbrainSetupState {
  state: 'ready' | 'unsupported_host' | 'executable_missing' | 'executable_untrusted'
  reason?: string
  hostPlatform: 'darwin' | 'linux' | 'other'
  executablePath?: string
  vaults: BigbrainSetupVault[]
  bindingsFile: BigbrainBindingsFileState['status']
  connectionName: typeof BIGBRAIN_SETUP_CONNECTION_NAME
  /** Upstream grants every named connection whole-vault read plus inbox contribution. */
  access: readonly ['vault:read', 'inbox:write']
}
export type BigbrainSetupInput = ({ vaultId: string } | { vaultPath: string }) & {
  confirmVaultAccess: true
  replaceExisting?: boolean
}
export interface BigbrainSetupResult {
  connection: SafeIntegrationConnection
  vault: BigbrainSetupVault
  bindingsFile: 'created' | 'updated' | 'unchanged'
  connectionOutcome: 'created' | 'updated' | 'reused'
  enabled: boolean
}

type Connections = Pick<
  IntegrationConnectionService,
  'create' | 'enable' | 'validate' | 'replaceCredential' | 'safeView'
>
interface Repository {
  list(providerKey: string): Promise<readonly IntegrationConnectionRecord[]>
  get(id: string): Promise<IntegrationConnectionRecord | null>
}
export type SetupCommand = (options: { executablePath: string; vaultPath: string }) => Promise<{ clientId: string }>

function printable(value: string): boolean {
  return [...value].every((c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127)
}
export function vaultSelectionId(realVaultPath: string): string {
  return createHash('sha256').update(realVaultPath).digest('hex').slice(0, 16)
}
function managedBindingId(realVaultPath: string): string {
  return MANAGED_ID_PREFIX + createHash('sha256').update(realVaultPath).digest('hex').slice(0, 12)
}
function vaultLabel(realVaultPath: string): string {
  const name =
    [...basename(realVaultPath)]
      .filter((c) => printable(c))
      .join('')
      .trim() || 'vault'
  return `BigBrain · ${name}`.slice(0, 120)
}
function uniqueName(base: string, taken: readonly string[]): string {
  const names = new Set(taken)
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? base : `${base.slice(0, 110)} (${n})`
    if (!names.has(candidate)) return candidate
  }
}
/** Field-wise: stored configuration is JSONB, which does not preserve key order. */
function samePinnedConfiguration(stored: unknown, current: BigbrainConfigV2): boolean {
  const value = stored as Partial<BigbrainConfigV2> | null
  return (
    !!value &&
    typeof value === 'object' &&
    (Object.keys(current) as (keyof BigbrainConfigV2)[]).every((key) => value[key] === current[key]) &&
    Object.keys(value).length === Object.keys(current).length
  )
}
function bindingIdOf(record: { configuration: unknown }): string | undefined {
  const value = record.configuration as Partial<BigbrainConfigV2> | null
  return value && typeof value === 'object' && typeof value.bindingId === 'string' ? value.bindingId : undefined
}

/**
 * One-click local BigBrain setup on the Core host. Core detects the `bigbrain` command and the
 * vault itself; a person confirms the vault (detected, or a typed Core-host folder that must be
 * a real BigBrain vault) and its whole-vault access. Core then runs upstream `bigbrain mcp config`
 * with fixed argv, writes the managed bindings file, and creates/validates/enables the
 * connection. Re-running reuses BigBrain's same named connection and the same Ficus connection.
 */
export class BigbrainLocalSetup {
  readonly #home: string
  readonly #osHome: string | undefined
  readonly #availability: () => { available: boolean; reason?: string }
  readonly #command: SetupCommand
  readonly #platform: NodeJS.Platform
  #queue: Promise<unknown> = Promise.resolve()
  constructor(
    readonly bindings: Pick<BigbrainBindings, 'inspect' | 'write' | 'resolve'>,
    readonly connections: Connections,
    readonly repository: Repository,
    options: {
      home?: string
      osHome?: string
      availability?: () => { available: boolean; reason?: string }
      command?: SetupCommand
      platform?: NodeJS.Platform
    } = {}
  ) {
    this.#home = options.home ?? getHomeDir()
    this.#osHome = options.osHome ?? getDefaultEnvironment().HOME
    this.#availability = options.availability ?? bigbrainHostAvailability
    this.#command = options.command ?? runBigbrainSetupCommand
    this.#platform = options.platform ?? process.platform
  }

  async state(): Promise<BigbrainSetupState> {
    const base = {
      hostPlatform: this.#platform === 'darwin' ? 'darwin' : this.#platform === 'linux' ? 'linux' : 'other',
      connectionName: BIGBRAIN_SETUP_CONNECTION_NAME,
      access: ['vault:read', 'inbox:write'],
    } as const
    const availability = this.#availability()
    if (!availability.available)
      return { ...base, state: 'unsupported_host', reason: availability.reason, vaults: [], bindingsFile: 'none' }
    const file = await this.bindings.inspect()
    const vaults = await this.#detectVaults(file)
    try {
      const executable = await this.#executable()
      return { ...base, state: 'ready', executablePath: executable, vaults, bindingsFile: file.status }
    } catch (error) {
      const code = error instanceof BigbrainSetupError ? error.code : 'executable_missing'
      return {
        ...base,
        state: code === 'executable_untrusted' ? code : 'executable_missing',
        reason: MESSAGES[code === 'executable_untrusted' ? code : 'executable_missing'],
        vaults,
        bindingsFile: file.status,
      }
    }
  }

  /** Serialized: the bindings file and connection pool change one setup at a time. */
  connect(input: BigbrainSetupInput, actor: string): Promise<BigbrainSetupResult> {
    const run = this.#queue.then(
      () => this.#connect(input, actor),
      () => this.#connect(input, actor)
    )
    this.#queue = run.catch(() => {})
    return run
  }

  /** After a Ficus connection is removed: drop its managed binding once nothing uses it. */
  async release(bindingId: string): Promise<void> {
    if (!bindingId.startsWith(MANAGED_ID_PREFIX)) return
    const task = this.#queue.then(async () => {
      if ((await this.repository.list('bigbrain')).some((record) => bindingIdOf(record) === bindingId)) return
      const file = await this.bindings.inspect()
      if (file.status !== 'managed' || !file.bindings.some((entry) => entry.id === bindingId)) return
      await this.bindings.write(file.bindings.filter((entry) => entry.id !== bindingId))
    })
    this.#queue = task.catch(() => {})
    return task
  }

  async #connect(input: BigbrainSetupInput, actor: string): Promise<BigbrainSetupResult> {
    const availability = this.#availability()
    if (!availability.available) throw new BigbrainSetupError('unsupported_host', availability.reason)
    if (input.confirmVaultAccess !== true) throw new BigbrainSetupError('confirmation_required')
    const file = await this.bindings.inspect()
    let vault: BigbrainSetupVault
    if ('vaultId' in input) {
      const found = (await this.#detectVaults(file)).find((candidate) => candidate.id === input.vaultId)
      if (!found) throw new BigbrainSetupError('vault_not_found')
      vault = found
    } else {
      // A person typed a Core-host folder: accepted only if it is a real private BigBrain vault.
      const real = await this.#checkVault(input.vaultPath)
      vault = (await this.#detectVaults(file)).find((candidate) => candidate.vaultPath === real) ?? {
        id: vaultSelectionId(real),
        label: vaultLabel(real),
        vaultPath: real,
        source: 'chosen_folder',
      }
    }
    // Recheck at use time: a detected vault may have changed since it was listed.
    await this.#checkVault(vault.vaultPath)
    if ((file.status === 'unmanaged' || file.status === 'invalid') && input.replaceExisting !== true)
      throw new BigbrainSetupError('confirmation_required')
    const executablePath = await this.#executable()
    const executableTarget = await realpath(executablePath)

    let clientId: string
    try {
      ;({ clientId } = await this.#command({ executablePath: executableTarget, vaultPath: vault.vaultPath }))
    } catch (error) {
      if (!(error instanceof BigbrainSetupCommandError)) throw new BigbrainSetupError('upstream_failed')
      throw new BigbrainSetupError(
        (
          {
            executable_missing: 'executable_missing',
            busy: 'busy',
            timeout: 'upstream_timeout',
            connection_revoked: 'upstream_connection_revoked',
            no_vault: 'vault_not_found',
            failed: 'upstream_failed',
            invalid_output: 'upstream_invalid_output',
          } as const
        )[error.code]
      )
    }

    const entry: BigbrainBindingDeclaration = {
      id: managedBindingId(vault.vaultPath),
      label: vaultLabel(vault.vaultPath),
      vaultPath: vault.vaultPath,
      executablePath,
      clientId,
    }
    const kept = file.bindings.filter((existing) => existing.id !== entry.id)
    const previous = file.bindings.find((existing) => existing.id === entry.id)
    if (kept.length + 1 > 32) throw new BigbrainSetupError('too_many_vaults')
    const unchanged = file.status === 'managed' && previous && JSON.stringify(previous) === JSON.stringify(entry)
    if (!unchanged) {
      try {
        await this.bindings.write([...kept, entry])
      } catch {
        throw new BigbrainSetupError('bindings_write_failed')
      }
    }

    let configuration: BigbrainConfigV2
    try {
      configuration = (await this.bindings.resolve(entry.id)).configuration
    } catch (error) {
      if (error instanceof BigbrainError && error.code === 'unsupported_host')
        throw new BigbrainSetupError('unsupported_host', this.#availability().reason)
      throw new BigbrainSetupError('credential_unavailable')
    }

    const { connection, outcome } = await this.#upsertConnection(entry, configuration, vault, actor)
    let current = connection
    let enabled = connection.enabled
    try {
      current = connection.enabled
        ? await this.connections.validate(connection.id, actor)
        : await this.connections.enable(connection.id, actor)
      enabled = current.enabled && !current.lastErrorCode
    } catch {
      // Enable validation failed: the connection records the fixed error code for display.
      const record = await this.repository.get(connection.id)
      if (record) current = await this.connections.safeView(record)
      enabled = false
    }
    return {
      connection: current,
      vault,
      bindingsFile: unchanged ? 'unchanged' : previous || file.status !== 'none' ? 'updated' : 'created',
      connectionOutcome: outcome,
      enabled,
    }
  }

  async #upsertConnection(
    entry: BigbrainBindingDeclaration,
    configuration: BigbrainConfigV2,
    vault: BigbrainSetupVault,
    actor: string
  ): Promise<{ connection: SafeIntegrationConnection; outcome: BigbrainSetupResult['connectionOutcome'] }> {
    const all = await this.repository.list('bigbrain')
    const existing = all.filter((record) => bindingIdOf(record) === entry.id)
    const same = existing.find((record) => samePinnedConfiguration(record.configuration, configuration))
    if (same) return { connection: await this.connections.safeView(same), outcome: 'reused' }
    const stale = existing[0]
    if (stale) {
      // Same vault (the managed ID is derived from it); only the executable target or BigBrain
      // client ID moved. Re-pin in place so squads keep the connection they already selected.
      return {
        connection: await this.connections.replaceCredential(
          stale.id,
          entry.clientId,
          actor,
          true,
          configuration,
          true
        ),
        outcome: 'updated',
      }
    }
    return {
      connection: await this.connections.create({
        providerKey: 'bigbrain',
        adapterVersion: 2,
        configuration,
        credential: entry.clientId,
        // Display names are unique per provider; two vaults may share a folder name.
        displayName: uniqueName(
          vault.label,
          all.map((record) => record.displayName)
        ),
        actor,
        clientAuthority: 'local',
        authorizationGrant: true,
      }),
      outcome: 'created',
    }
  }

  /** `~/.local/bin/bigbrain` under the Core service user's OS HOME (BigBrain.app's shim or a
   * source install's symlink). Never a client-supplied path. */
  async #executable(): Promise<string> {
    if (!this.#osHome || !isAbsolute(this.#osHome)) throw new BigbrainSetupError('executable_missing')
    const path = join(this.#osHome, '.local', 'bin', 'bigbrain')
    let target: string
    try {
      target = await realpath(path)
      if (!(await stat(target)).isFile()) throw new Error('not a file')
      await access(target, constants.X_OK)
    } catch {
      throw new BigbrainSetupError('executable_missing')
    }
    try {
      await assertTrustedPath(target)
      await assertTrustedPath(join(this.#osHome, '.local', 'bin'))
    } catch {
      throw new BigbrainSetupError('executable_untrusted')
    }
    const exposed = await agentExposedRoots(this.#home)
    if (overlapsAny(exposed, target) || overlapsAny(exposed, path)) throw new BigbrainSetupError('executable_untrusted')
    return path
  }

  /** BigBrain knows one machine vault: the `~/.config/bigbrain/vault` pointer, else `~/vault`
   * (upstream `lib/engine.ts` and the app's `vault_root`). Vaults already in the bindings file
   * are offered too. Only real, private BigBrain vaults are listed. */
  async #detectVaults(file: BigbrainBindingsFileState): Promise<BigbrainSetupVault[]> {
    const candidates: { path: string; source: BigbrainSetupVault['source'] }[] = []
    if (this.#osHome && isAbsolute(this.#osHome)) {
      const pointer = await this.#readPointer(join(this.#osHome, '.config', 'bigbrain', 'vault'))
      if (pointer) candidates.push({ path: pointer, source: 'bigbrain_default' })
      else candidates.push({ path: join(this.#osHome, 'vault'), source: 'bigbrain_fallback' })
    }
    for (const entry of file.bindings) candidates.push({ path: entry.vaultPath, source: 'existing_binding' })
    const vaults: BigbrainSetupVault[] = []
    for (const candidate of candidates) {
      try {
        const real = await this.#checkVault(candidate.path)
        if (vaults.some((vault) => vault.vaultPath === real)) continue
        vaults.push({ id: vaultSelectionId(real), label: vaultLabel(real), vaultPath: real, source: candidate.source })
      } catch {
        /* Not a usable vault: not offered. */
      }
    }
    return vaults
  }

  async #readPointer(path: string): Promise<string | null> {
    try {
      const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      try {
        if (!(await file.stat()).isFile()) return null
        const buffer = Buffer.alloc(4097)
        const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
        if (bytesRead > 4096) return null
        const value = buffer.subarray(0, bytesRead).toString('utf8').trim()
        return value && isAbsolute(value) && printable(value) ? value : null
      } finally {
        await file.close()
      }
    } catch {
      return null
    }
  }

  /** A typed or detected folder must be an existing BigBrain vault with a regular `vault.yaml`,
   * privately owned, and outside every Ficus agent root. Returns its canonical path. */
  async #checkVault(path: string): Promise<string> {
    if (typeof path !== 'string' || !path || path.length > 4096 || !isAbsolute(path) || !printable(path))
      throw new BigbrainSetupError('vault_not_found')
    let real: string
    try {
      real = await realpath(path)
      if (!(await stat(real)).isDirectory() || !(await lstat(join(real, 'vault.yaml'))).isFile())
        throw new Error('not a vault')
    } catch {
      throw new BigbrainSetupError('vault_not_found')
    }
    try {
      await assertTrustedPath(real)
    } catch {
      throw new BigbrainSetupError('vault_untrusted')
    }
    if (overlapsAny(await agentExposedRoots(this.#home), real)) throw new BigbrainSetupError('vault_untrusted')
    return real
  }
}
