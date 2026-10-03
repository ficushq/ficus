import { z } from 'zod'

/**
 * How an inbox message should appear as a phone/browser push, when that differs from the
 * message's own subject and content. The inbox row stays the durable record written for its
 * recipient (often an agent); this is the human-facing alert derived from it.
 *
 * Stored at `metadata.push` on the inbox row. Only system-authored messages are trusted to
 * carry one (agents and users cannot restyle their own alerts).
 */
export const inboxPushPresentationSchema = z
  .object({
    title: z.string().trim().min(1).max(120),
    body: z.string().trim().min(1).max(300),
    /** Original Markdown when a producer clips its presentation. Only push renderers
     * consume this source, converting to plain text before applying payload limits. */
    source: z
      .object({ title: z.string().optional(), body: z.string().optional(), subtitle: z.string().optional() })
      .strict()
      .optional(),
    /** Rendered under the title on iOS; typically the squad name. */
    subtitle: z.string().trim().min(1).max(80).optional(),
    /** A later push with the same key replaces this one on the device. */
    collapseKey: z.string().trim().min(1).max(64).optional(),
    /** Pushes sharing a key are grouped together on the device. */
    threadKey: z.string().trim().min(1).max(64).optional(),
    /** passive = silent, no lock-screen interruption; active = normal; time-sensitive = breaks through focus. */
    interruptionLevel: z.enum(['passive', 'active', 'time-sensitive']).optional(),
  })
  .strict()

export type InboxPushPresentation = z.infer<typeof inboxPushPresentationSchema>

/** Read a stored presentation; anything malformed is treated as absent so delivery falls back to subject/content. */
export function parseInboxPushPresentation(value: unknown): InboxPushPresentation | undefined {
  const parsed = inboxPushPresentationSchema.safeParse(value)
  return parsed.success ? parsed.data : undefined
}
