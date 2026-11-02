import { z } from 'zod'

/** Routing evidence only; these fields confer no content trust or execution authority. */
export const githubPullRequestAuthorFields = {
  author: z
    .string()
    .max(100)
    .regex(/^[a-z0-9-]+(?:\[bot\])?$/i)
    .refine((login) => login.toLowerCase() !== 'ghost')
    .optional(),
  authorType: z.enum(['User', 'Bot']).optional(),
}

/** Read only the provider's PR user, never the sender, reviewer or comment author. */
export function githubPullRequestAuthor(user: unknown): { author?: string; authorType?: 'User' | 'Bot' } {
  if (!user || typeof user !== 'object' || Array.isArray(user)) return {}
  const { login, type } = user as Record<string, unknown>
  const author = githubPullRequestAuthorFields.author.safeParse(login)
  if (!author.success || !author.data) return {}
  return {
    author: author.data,
    ...(type === 'User' || type === 'Bot' ? { authorType: type } : {}),
  }
}

/** Workflow-run PR summaries usually omit user; do not infer it from the run actor or head commit. */
export function githubWorkflowPullRequestAuthor(pullRequests: unknown, number: number, repository: string) {
  const parent = Array.isArray(pullRequests)
    ? pullRequests.find(
        (pr) =>
          pr?.number === number &&
          (!pr.base?.repo?.full_name ||
            (typeof pr.base.repo.full_name === 'string' && pr.base.repo.full_name.toLowerCase() === repository))
      )
    : undefined
  return githubPullRequestAuthor(parent?.user)
}
