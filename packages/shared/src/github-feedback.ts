import { z } from 'zod'

/** GitHub's numeric account identity, never an editable login or association label. */
export const githubAccountIdSchema = z
  .string()
  .regex(/^[1-9][0-9]{0,15}$/)
  .refine((value) => Number.isSafeInteger(Number(value)), 'Invalid GitHub account ID')

export const githubFeedbackSelectionSchema = z
  .object({
    revisionId: z.string().uuid(),
    contentHash: z.string().regex(/^[0-9a-f]{64}$/),
    decisionVersion: z.number().int().nonnegative(),
  })
  .strict()

/** All authority and content are read from storage, not supplied by the caller. */
export const moderateGitHubFeedbackSchema = z
  .object({
    requestId: z.string().uuid(),
    action: z.enum(['allow_once', 'deny', 'allow_trust']),
    selections: z.array(githubFeedbackSelectionSchema).min(1).max(50),
  })
  .strict()
  .refine(
    ({ selections }) => new Set(selections.map((selection) => selection.revisionId)).size === selections.length,
    'Select each revision only once'
  )

export type GitHubFeedbackSelection = z.infer<typeof githubFeedbackSelectionSchema>
export type ModerateGitHubFeedback = z.infer<typeof moderateGitHubFeedbackSchema>
export type GitHubFeedbackDecision = ModerateGitHubFeedback['action'] | 'pending' | 'automatic' | 'historical'
export type GitHubFeedbackReleaseState = 'held' | 'ready' | 'retry' | 'retained' | 'delivered' | 'obsolete'
export type GitHubTrustOrigin = { kind: 'manual'; addedByUserId: string } | { kind: 'linked_user'; userId: string }

export interface GitHubAccountIdentity {
  accountId: string
  login: string
  accountType: 'User' | 'Bot'
}

/** Personal ownership is distinct from configuring any squad integration. */
export interface GitHubPersonalIdentityStatus {
  linked: { accountId: string; login: string; linkedAt: string } | null
  confirmation: { id: string; accountId: string; login: string; expiresAt: string } | null
  authorization: { configured: boolean; authority: 'local' | 'platform_broker'; mode: 'browser' | 'device' }
}
