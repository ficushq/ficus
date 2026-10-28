import { createHash } from 'node:crypto'
import { z } from 'zod'
import { controlReceiptSchema, type ControlReceipt } from './receipts'
import { managedPaths } from './paths'
import { runPrivateCommand, vaultCommand, type PrivateCommandRunner } from './process'
const permissions = z
  .array(z.enum(['read', 'write']))
  .max(2)
  .refine((v) => new Set(v).size === v.length)
export const nativeMemberSchema = z.object({
  id: z.string().regex(/^mem_[0-9a-f]{8}$/),
  handle: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/),
  role: z.enum(['owner', 'member']),
  permissions,
  revoked: z.iso.datetime().nullable(),
})
export const nativeCredentialSchema = z.object({
  id: z.string().regex(/^[0-9a-f]{8}$/),
  member_id: nativeMemberSchema.shape.id,
  name: z.string().max(120),
  kind: z.enum(['person', 'agent']),
  scopes: permissions,
  followsMember: z.boolean().optional().default(false),
  minted_by: z.string().optional(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  revoked: z.iso.datetime().nullable(),
})
const mintedSchema = z.object({
  credential: nativeCredentialSchema,
  token: z.string().regex(/^sv_[0-9a-f]{8}_[A-Za-z0-9_-]{43}$/),
})
export type NativeMember = z.infer<typeof nativeMemberSchema>
export type NativeMint = z.infer<typeof mintedSchema>
function readMember(member: NativeMember): boolean {
  return (
    member.handle === 'ficus-reader' &&
    member.role === 'member' &&
    !member.revoked &&
    member.permissions.length === 1 &&
    member.permissions[0] === 'read'
  )
}
function validToken(minted: NativeMint, member: NativeMember, kind: 'person' | 'agent'): boolean {
  const credential = minted.credential
  return (
    credential.id === minted.token.slice(3, 11) &&
    credential.member_id === member.id &&
    !credential.revoked &&
    credential.kind === kind &&
    !credential.followsMember &&
    credential.minted_by === undefined &&
    credential.sha256 === createHash('sha256').update(minted.token).digest('hex') &&
    credential.scopes.length === member.permissions.length &&
    member.permissions.every((p) => credential.scopes.includes(p))
  )
}
/** Private typed lifecycle adapter, never an HTTP/tool command surface. Caller MUST hold
 * the lifecycle lock and verify the recorded live mount before using it. Root escrow handles
 * bootstrap output; it is never Core read material. Every CLI runs as the vault UID/GID.
 */
export class NativeVaultAdmin {
  private readonly record: ControlReceipt
  private readonly run: PrivateCommandRunner
  private readonly paths: ReturnType<typeof managedPaths>
  constructor(record: ControlReceipt, options: { root?: string; run?: PrivateCommandRunner } = {}) {
    this.record = controlReceiptSchema.parse(record)
    if (
      !this.record.os ||
      this.record.receipt.state === 'deleted' ||
      ['reserved', 'deleting', 'deleted'].includes(this.record.phase)
    )
      throw new Error('storage_unavailable')
    this.paths = managedPaths({ root: options.root, vaultId: this.record.receipt.vaultId })
    this.run = options.run ?? runPrivateCommand
  }
  private async invoke<S extends z.ZodTypeAny>(args: string[], schema: S, maxOutputBytes = 16384): Promise<z.infer<S>> {
    const binary = `/opt/ficus-bigbrain/releases/${this.record.receipt.artifactDigest.slice(7)}/bigbrain-shared.js`
    const result = await this.run(
      vaultCommand(this.record.os!, binary, [
        ...args,
        '--vault',
        this.paths.vault,
        '--members',
        this.paths.memberStore,
        '--json',
      ]),
      { maxOutputBytes }
    )
    if (result.code !== 0) throw new Error('upstream_unavailable')
    try {
      return schema.parse(JSON.parse(result.stdout))
    } catch {
      throw new Error('invalid_response')
    }
  }
  async initializeOwner() {
    if (this.record.phase !== 'storage_ready') throw new Error('generation_conflict')
    const initialized = await this.invoke(
      ['init', '--owner', this.record.owner.handle, '--display', this.record.owner.display],
      mintedSchema.extend({ member: nativeMemberSchema, vault: z.string(), members: z.string() })
    )
    const member = initialized.member
    if (
      initialized.vault !== this.paths.vault ||
      initialized.members !== this.paths.memberStore ||
      member.handle !== this.record.owner.handle ||
      member.role !== 'owner' ||
      member.revoked ||
      member.permissions.length !== 2 ||
      !member.permissions.includes('read') ||
      !member.permissions.includes('write') ||
      !validToken(initialized, member, 'person')
    )
      throw new Error('invalid_response')
    return initialized
  }
  async listMembers(): Promise<NativeMember[]> {
    return this.invoke(['member', 'list'], z.array(nativeMemberSchema).max(4096), 1048576)
  }
  async ensureReadMember(): Promise<NativeMember> {
    let member = (await this.listMembers()).find((m) => m.handle === 'ficus-reader')
    if (!member)
      member = await this.invoke(
        ['member', 'add', 'ficus-reader', '--permissions', 'read', '--display', 'Ficus'],
        nativeMemberSchema
      )
    if (!readMember(member)) throw new Error('identity_mismatch')
    return member
  }
  async mintReadCredential(input: unknown): Promise<NativeMint> {
    const checked = nativeMemberSchema.safeParse(input)
    if (!checked.success || !readMember(checked.data)) throw new Error('identity_mismatch')
    const label = `Ficus read ${this.record.operation.requestId}`
    const minted = await this.invoke(
      ['credential', 'mint', 'ficus-reader', '--name', label, '--kind', 'agent', '--scopes', 'read'],
      mintedSchema
    )
    if (!validToken(minted, checked.data, 'agent') || minted.credential.name !== label)
      throw new Error('invalid_response')
    return minted
  }
  async listCredentials() {
    return this.invoke(['credential', 'list'], z.array(nativeCredentialSchema).max(4096), 1048576)
  }
  async revokeCredential(id: string): Promise<void> {
    if (!/^[a-f0-9]{8}$/.test(id)) throw new Error('invalid_request')
    await this.invoke(['credential', 'revoke', id], z.strictObject({ id: z.literal(id), revoked: z.literal(true) }))
  }
}
