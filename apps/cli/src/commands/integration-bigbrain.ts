/**
 * `ficus integration bigbrain vault …`: human management of managed shared BigBrain vaults.
 *
 * The backend enforces literal human authority for every command. Owner device links and member
 * invite links are secrets: each is only ever written to a NEW 0600 file chosen with --out (never
 * stdout, never JSON output, never an existing path or symlink); the terminal shows only the path
 * and expiry.
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
interface MemberInvite extends OwnerInvite {
  inviteId: string
  displayName: string
  access: string
}
interface RosterView {
  members: { handle: string; displayName: string; access: string; status: string; system: string | null }[]
  invites: { inviteId: string; displayName: string; access: string; expiresAt: string }[]
  membersTruncated: boolean
  invitesTruncated: boolean
}
const HANDLE = /^[a-z0-9][a-z0-9._-]{0,63}$/
const INVITE_ID = /^[0-9a-f]{24}$/
function access(value: string): 'read' | 'write' {
  if (value !== 'read' && value !== 'write') throw new Error('--access must be read or write')
  return value
}
function memberHandle(value: string): string {
  if (!HANDLE.test(value)) throw new Error('Member must be a BigBrain handle (from `members`)')
  return value
}
function inviteId(value: string): string {
  if (!INVITE_ID.test(value)) throw new Error('Invite ID must be the 24-character ID from `members`')
  return value
}
/** Refuse an existing --out before any request, then write the link to a new 0600 file. */
async function secretOut(out: string | undefined, what: string): Promise<string> {
  if (!out) throw new Error(`--out <file> is required: the ${what} is never printed`)
  const target = resolve(out)
  if (await lstat(target).catch(() => null))
    throw new Error('Refusing to overwrite an existing path; choose a new file for --out')
  return target
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
    .description(
      "Create a shared vault for this Ficus server. Its owner in BigBrain is 'ficus'; people who manage " +
        'BigBrain here connect devices as that owner'
    )
    .requiredOption('--name <name>', 'Vault name')
    .action(
      run(async (options: { name: string }) =>
        output(summary(await apiPost<VaultView>(BASE, { requestId: randomUUID(), displayName: options.name })))
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
    .command('owner-link <vault>')
    .description(
      "Write a single-use link that connects a BigBrain app as the vault's owner to a new private file (never " +
        'printed). Anyone holding it gets full owner access and writes as the shared owner; invite people as ' +
        'members to give them their own name'
    )
    .requiredOption('--generation <n>', 'Current vault generation (from list)')
    .option('--out <file>', 'New file to create with mode 0600 (required)')
    .action(
      run(async (id: string, options: { generation: string; out?: string }) => {
        const target = await secretOut(options.out, 'device link')
        const invite = await apiPost<OwnerInvite>(path(id, '/owner-invite'), fence(options))
        const written = await dependencies.writeSecretFile(target, `${invite.inviteUrl}\n`)
        output(
          { written, expiresAt: invite.expiresAt },
          `Owner device link written to ${written} (expires ${invite.expiresAt}). Open it only on the device to connect.`
        )
      })
    )

  vault
    .command('members <vault>')
    .description('List a vault’s members and pending invites (never invite links)')
    .action(
      run(async (id: string) => {
        const roster = await apiGet<RosterView>(path(id, '/members'))
        output({
          members: roster.members.map(({ handle, displayName, access, status, system }) => ({
            handle,
            displayName,
            access,
            status,
            system,
          })),
          invites: roster.invites,
          membersTruncated: roster.membersTruncated,
          invitesTruncated: roster.invitesTruncated,
        })
      })
    )

  vault
    .command('invite <vault>')
    .description(
      'Invite one person as a new member with their own name: writes a single-use, 24-hour invite link to a new ' +
        'private file (never printed). Send it to that person privately; whoever opens it first becomes the member'
    )
    .option('--name <name>', "The member's name (required)")
    .option('--access <access>', 'read, or write (read and write)', 'read')
    .requiredOption('--generation <n>', 'Current vault generation (from list)')
    .option('--out <file>', 'New file to create with mode 0600 (required)')
    .action(
      run(async (id: string, options: { name?: string; access: string; generation: string; out?: string }) => {
        const name = options.name?.trim()
        if (!name)
          throw new Error('--name is required for a member invite (for an owner device link, use `owner-link`)')
        if (name.length > 120) throw new Error('--name must be at most 120 characters')
        const level = access(options.access)
        const target = await secretOut(options.out, 'invite link')
        const invite = await apiPost<MemberInvite>(path(id, '/invites'), {
          ...fence(options),
          displayName: name,
          access: level,
        })
        const written = await dependencies.writeSecretFile(target, `${invite.inviteUrl}\n`)
        output(
          { written, inviteId: invite.inviteId, access: invite.access, expiresAt: invite.expiresAt },
          `Member invite for ${invite.displayName} (${invite.access}) written to ${written} (expires ${invite.expiresAt}). Send it to them privately.`
        )
      })
    )

  vault
    .command('cancel-invite <vault> <invite>')
    .description('Cancel a pending member invite so its link can no longer be used')
    .requiredOption('--generation <n>', 'Current vault generation (from list)')
    .action(
      run(async (id: string, invite: string, options: { generation: string }) =>
        output(
          await apiPost<{ inviteId: string; cancelled: true }>(
            path(id, `/invites/${inviteId(invite)}/cancel`),
            fence(options)
          )
        )
      )
    )

  vault
    .command('set-access <vault> <member>')
    .description('Change a member’s access to read, or write (read and write). The owner and Ficus reader are fixed')
    .requiredOption('--access <access>', 'read or write')
    .requiredOption('--generation <n>', 'Current vault generation (from list)')
    .action(
      run(async (id: string, member: string, options: { access: string; generation: string }) =>
        output(
          await apiPost(path(id, `/members/${memberHandle(member)}/access`), {
            ...fence(options),
            access: access(options.access),
          })
        )
      )
    )

  vault
    .command('remove-member <vault> <member>')
    .description(
      'Remove a member: ends their access on every device. What they wrote stays under their name; the handle is never reused'
    )
    .requiredOption('--generation <n>', 'Current vault generation (from list)')
    .action(
      run(async (id: string, member: string, options: { generation: string }) =>
        output(await apiPost(path(id, `/members/${memberHandle(member)}/remove`), fence(options)))
      )
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
