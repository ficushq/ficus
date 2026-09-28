import { z } from 'zod'
import type { GitHubRepositoryAccess } from '@ficus/shared'

const LIMIT = 20
const installationsSchema = z.object({
  total_count: z.number().int().nonnegative(),
  installations: z
    .array(
      z.object({
        id: z.number().int().positive(),
        account: z.object({ login: z.string().min(1).max(100) }),
        permissions: z.object({ contents: z.string().optional(), workflows: z.string().optional() }),
        suspended_at: z.string().nullable(),
      })
    )
    .max(LIMIT),
})
const repositoriesSchema = z.object({ total_count: z.number().int().nonnegative() })

/** Read-only, bounded check of this user's access through this App, not /repos user permissions. */
export async function checkGitHubRepositoryAccess(
  accessToken: string,
  login: string,
  fetcher: (input: string, init?: RequestInit) => Promise<Response> = fetch
): Promise<GitHubRepositoryAccess> {
  const signal = AbortSignal.timeout(15_000)
  async function get(path: string): Promise<unknown> {
    const response = await fetcher(`https://api.github.com${path}`, {
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      signal,
      redirect: 'error',
    })
    if (!response.ok || !response.body) {
      await response.body?.cancel()
      throw new Error('GitHub access check unavailable')
    }
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > 512 * 1024) throw new Error('GitHub access response too large')
        chunks.push(value)
      }
      return JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } finally {
      await reader.cancel().catch(() => {})
      reader.releaseLock()
    }
  }
  const result: GitHubRepositoryAccess = {
    status: 'unknown',
    personalAccountInstalled: null,
    complete: false,
    installations: [],
  }
  try {
    const page = installationsSchema.parse(await get(`/user/installations?per_page=${LIMIT}`))
    result.complete = page.total_count === page.installations.length
    const personal = page.installations.some(
      (installation) => installation.account.login.toLowerCase() === login.toLowerCase()
    )
    result.personalAccountInstalled = personal ? true : result.complete ? false : null
    // Four requests at a time, at most 21 total, all sharing the same deadline.
    for (let offset = 0; offset < page.installations.length; offset += 4) {
      const batch = await Promise.all(
        page.installations.slice(offset, offset + 4).map(async (installation) => {
          const item = {
            account: installation.account.login,
            repositoryCount: null as number | null,
            contentsWrite: installation.permissions.contents === 'write',
            workflowsWrite: installation.permissions.workflows === 'write',
            suspended: installation.suspended_at !== null,
          }
          if (item.suspended) return { ...item, repositoryCount: 0 }
          try {
            item.repositoryCount = repositoriesSchema.parse(
              await get(`/user/installations/${installation.id}/repositories?per_page=1`)
            ).total_count
          } catch {
            result.complete = false
          }
          return item
        })
      )
      result.installations.push(...batch)
    }
    result.status = result.installations.some((item) => (item.repositoryCount ?? 0) > 0)
      ? 'verified'
      : result.complete
        ? 'missing'
        : 'unknown'
  } catch {
    // Provider failures must not be presented as a missing installation.
  }
  return result
}
