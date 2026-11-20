import { z } from 'zod'

/**
 * Squad Linear integration settings, stored at squad metadata `integrationSettings.linear` beside the
 * `metadata.linear` team routes. Today they hold one setting: which Linear link kind the delivery pull
 * request gets on each tracked issue. Ficus itself never changes issue status; with `closes`, Linear's
 * GitHub integration completes the issue when the pull request merges.
 */

/** Linear's `GitLinkKind` values accepted by `attachmentLinkGitHubPR`. */
export const LINEAR_PULL_REQUEST_LINK_KINDS = ['closes', 'contributes', 'links'] as const
export type LinearPullRequestLinkKind = (typeof LINEAR_PULL_REQUEST_LINK_KINDS)[number]

const linkKindSchema = z.enum(LINEAR_PULL_REQUEST_LINK_KINDS)

export const squadLinearSettingsSchema = z.strictObject({
  version: z.literal(1),
  pullRequestLinks: z
    .strictObject({
      /** The link kind for the issue the stream was started from. */
      origin: linkKindSchema.optional(),
      /** The link kind for every other Linear issue the stream tracks. */
      tracked: linkKindSchema.optional(),
    })
    .optional(),
})
export type SquadLinearSettings = z.infer<typeof squadLinearSettingsSchema>

export interface EffectiveLinearSettings {
  version: 1
  pullRequestLinks: { origin: LinearPullRequestLinkKind; tracked: LinearPullRequestLinkKind }
}

export const DEFAULT_LINEAR_PULL_REQUEST_LINKS: EffectiveLinearSettings['pullRequestLinks'] = {
  origin: 'closes',
  tracked: 'links',
}

/** The stored value at `integrationSettings.linear`, or undefined when absent. */
export function storedLinearSettings(metadata: unknown): unknown {
  if (!metadata || typeof metadata !== 'object') return undefined
  const settings = (metadata as Record<string, unknown>).integrationSettings
  if (!settings || typeof settings !== 'object') return undefined
  return (settings as Record<string, unknown>).linear
}

/**
 * The squad's settings with defaults filled in. A stored value that no longer parses falls back to the
 * defaults, so a bad value can never block attaching a pull request.
 */
export function effectiveLinearSettings(metadata: unknown): EffectiveLinearSettings {
  const parsed = squadLinearSettingsSchema.safeParse(storedLinearSettings(metadata))
  const links = parsed.success ? parsed.data.pullRequestLinks : undefined
  return {
    version: 1,
    pullRequestLinks: {
      origin: links?.origin ?? DEFAULT_LINEAR_PULL_REQUEST_LINKS.origin,
      tracked: links?.tracked ?? DEFAULT_LINEAR_PULL_REQUEST_LINKS.tracked,
    },
  }
}
