/**
 * `ficus integration bigbrain vault …`: human management of managed shared BigBrain vaults.
 *
 * The backend enforces literal human authority for every command. The owner device link is a
 * secret: it is only ever written to a NEW 0600 file chosen with --out (never stdout, never JSON
 * output, never an existing path or symlink); the terminal shows only the path and expiry.
 */
import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { link, lstat, open, unlink } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { Command } from 'commander'
import { apiDelete, apiGet, apiPatch, apiPost } from '../client'
import { output, outputError } from '../output'

const BASE = '/api/integrations/providers/bigbrain/shared-vaults'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

interface VaultView {
  vaultId: string
  displayName: string
  state: string
  readAccess: string
  desiredGeneration: number
  backup?: string
}
interface OwnerInvite {
  inviteUrl: string
  expiresAt: string
}

export interface BigbrainVaultCommandDependencies {
  writeSecretFile: (path: string, contents: string) => Promise<string>
}

function vaultId(value: string): string {
  if (!UUID.test(value)) throw new Error('Vault ID must be the full vault UUID')
  return value
}
function generation(value: string): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1)
    throw new Error('--generation must be the vault’s current generation')
  return parsed
}
const path = (id: string, suffix = '') => `${BASE}/${vaultId(id)}${suffix}`
const fence = (options: { generation: string }) => ({
  requestId: randomUUID(),
  expectedGeneration: generation(options.generation),
})
function summary(vault: VaultView) {
  return {
    vaultId: vault.vaultId,
    displayName: vault.displayName,
    state: vault.state,
    readAccess: vault.readAccess,
    generation: vault.desiredGeneration,
    // 'excluded': the most recent server backup did not include this vault.
    backup: vault.backup ?? 'unknown',
  }
}

/** Create `target` exclusively with mode 0600: never follows or replaces an existing path. */
export async function writeSecretFileExclusive(target: string, contents: string): Promise<string> {
  const destination = resolve(target)
  const existing = await lstat(destination).catch(() => null)
  if (existing) throw new Error('Refusing to overwrite an existing path; choose a new file for --out')
  const parent = await lstat(dirname(destination)).catch(() => null)
  if (!parent?.isDirectory()) throw new Error('The --out directory must exist')
  const temporary = join(dirname(destination), `.${basename(destination)}.${randomUUID()}.tmp`)
  const file = await open(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600
  )
  try {
    await file.writeFile(contents)
    await file.sync()
  } finally {
    await file.close()
  }
  try {
    // link() fails if the destination appeared meanwhile: no clobbering, no symlink following.
    await link(temporary, destination)
  } finally {
    await unlink(temporary).catch(() => {})
  }
  return destination
}

export function registerBigbrainVaultCommands(
  integration: Command,
  dependencies: BigbrainVaultCommandDependencies = { writeSecretFile: writeSecretFileExclusive }
): void {
  const vault = integration
    .command('bigbrain')
    .description('Managed shared BigBrain vaults')
    .command('vault')
    .description('Create and manage shared vaults (people write in the BigBrain app; squads read)')

  vault
    .command('list')
    .description('List shared vaults')
    .action(run(async () => output((await apiGet<{ vaults: VaultView[] }>(BASE)).vaults.map(summary))))

  vault
    .command('create')
    .description('Create a shared vault owned by you')
    .requiredOption('--name <name>', 'Vault name')
    .requiredOption('--handle <handle>', 'Your BigBrain handle in this vault (cannot be changed later)')
    .action(
      run(async (options: { name: string; handle: string }) =>
        output(
          summary(
            await apiPost<VaultView>(BASE, {
              requestId: randomUUID(),
              displayName: options.name,
              ownerHandle: options.handle,
            })
          )
        )
      )
    )

  vault
    .command('rename <vault>')
    .requiredOption('--name <name>', 'New vault name')
    .requiredOption('--generation <n>', 'Current vault generation (from list)')
    .action(
      run(async (id: string, options: { name: string; generation: string }) =>
        output(summary(await apiPatch<VaultView>(path(id), { ...fence(options), displayName: options.name })))
      )
    )

  vault
    .command('retry <vault>')
    .requiredOption('--generation <n>', 'Current vault generation (from list)')
    .action(
      run(async (id: string, options: { generation: string }) =>
        output(summary(await apiPost<VaultView>(path(id, '/retry'), fence(options))))
      )
    )

  for (const [command, action, description] of [
    ['revoke-read', 'revoke', 'Revoke Ficus read access (members keep using the vault)'],
    ['reconnect-read', 'reconnect', 'Mint a new read-only Ficus credential'],
  ] as const)
    vault
      .command(`${command} <vault>`)
      .description(description)
      .requiredOption('--generation <n>', 'Current vault generation (from list)')
      .action(
        run(async (id: string, options: { generation: string }) =>
          output(summary(await apiPost<VaultView>(path(id, '/read-access'), { ...fence(options), action })))
        )
      )

  vault
    .command('invite <vault>')
    .description('Write a single-use owner device link to a new private file (never printed)')
    .requiredOption('--generation <n>', 'Current vault generation (from list)')
    .option('--out <file>', 'New file to create with mode 0600 (required)')
    .action(
      run(async (id: string, options: { generation: string; out?: string }) => {
        if (!options.out) throw new Error('--out <file> is required: the device link is never printed')
        const target = resolve(options.out)
        if (await lstat(target).catch(() => null))
          throw new Error('Refusing to overwrite an existing path; choose a new file for --out')
        const invite = await apiPost<OwnerInvite>(path(id, '/owner-invite'), fence(options))
        const written = await dependencies.writeSecretFile(target, `${invite.inviteUrl}\n`)
        output(
          { written, expiresAt: invite.expiresAt },
          `Owner device link written to ${written} (expires ${invite.expiresAt}). Open it only on your own device.`
        )
      })
    )

  vault
    .command('delete <vault>')
    .description(
      'Delete a shared vault and its current data. Existing server backups are not changed, and restoring a backup taken before now brings the vault back with read access off'
    )
    .requiredOption('--name <name>', 'The exact vault name, to confirm')
    .requiredOption('--generation <n>', 'Current vault generation (from list)')
    .action(
      run(async (id: string, options: { name: string; generation: string }) =>
        output(
          summary(
            await apiDelete<VaultView>(path(id), {
              ...fence(options),
              confirmedVaultId: vaultId(id),
              confirmedName: options.name,
            })
          )
        )
      )
    )
}

function run<T extends unknown[]>(handler: (...args: T) => Promise<void>): (...args: T) => Promise<void> {
  return async (...args) => {
    try {
      await handler(...args)
    } catch (error) {
      // Never echo a response body: errors carry codes/messages only.
      outputError(error as Error)
    }
  }
}
