import type { z } from 'zod'
import type { InstalledHost } from './control-input'
import { memberAdminReplySchema, type MemberAdminInput } from './member-admin'
import { runPrivateCommand, vaultCommand, type PrivateCommandRunner } from './process'
import type { ControlReceipt } from './receipts'

/** One member-admin call as the vault UID (default: the installed release's bigbrain-members
 * bundle). Returns the adapter's `result` or throws its fixed code. */
export type MemberAdminCall = (record: ControlReceipt, input: MemberAdminInput) => Promise<unknown>
export interface MemberAdapterDeps {
  run?: PrivateCommandRunner
  memberAdmin?: MemberAdminCall
}

/** The member adapter of the INSTALLED release: vaults keep the release recorded at create, which
 * may predate it. Every release runs the same pinned upstream, so the member store is the same. */
export function memberAdminScript(host: Pick<InstalledHost, 'artifactDigest'>): string {
  return `/opt/ficus-bigbrain/releases/${host.artifactDigest.slice(7)}/bigbrain-members.js`
}

export function memberAdapter(host: Pick<InstalledHost, 'artifactDigest'>, deps: MemberAdapterDeps): MemberAdminCall {
  if (deps.memberAdmin) return deps.memberAdmin
  return async (record, input) => {
    if (!record.os) throw new Error('storage_unavailable')
    const result = await (deps.run ?? runPrivateCommand)(vaultCommand(record.os, memberAdminScript(host), []), {
      input: JSON.stringify(input),
      maxOutputBytes: 262144,
    })
    if (result.code !== 0) throw new Error('upstream_unavailable')
    let reply: z.infer<typeof memberAdminReplySchema>
    try {
      reply = memberAdminReplySchema.parse(JSON.parse(result.stdout.trim().split('\n').at(-1) ?? ''))
    } catch {
      throw new Error('upstream_protocol')
    }
    if (!reply.ok) throw new Error(reply.code)
    return reply.result
  }
}
