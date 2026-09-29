import { getGitHubAuthorDefaults } from '../integrations/github/author-defaults'
import { eq } from 'drizzle-orm'
import { db, squads } from '../../db'
import { getSecretStore } from '../secrets'

export interface GitHubIdentity {
  gitUserName?: string
  gitUserEmail?: string
}

interface SquadGitHubIdentityMetadata {
  gitUserName?: unknown
  gitUserEmail?: unknown
}

export interface ResolveGitHubIdentityInput {
  metadata?: Record<string, unknown> | null
  getSecret: (key: string) => string | undefined
  githubDefaults?: GitHubIdentity
  hostGitUserName?: string
  hostGitUserEmail?: string
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

function readGitConfig(key: 'user.name' | 'user.email'): string | undefined {
  const result = Bun.spawnSync(['git', 'config', '--global', key], { stdout: 'pipe', stderr: 'ignore' })
  if (result.exitCode !== 0) return undefined
  return nonEmptyString(result.stdout.toString())
}

export function resolveGitHubIdentityFromMetadata(input: ResolveGitHubIdentityInput): GitHubIdentity {
  const candidate = input.metadata?.githubIdentity
  const metadataIdentity: SquadGitHubIdentityMetadata | undefined =
    candidate && typeof candidate === 'object' && !Array.isArray(candidate)
      ? (candidate as SquadGitHubIdentityMetadata)
      : undefined

  return {
    gitUserName:
      nonEmptyString(metadataIdentity?.gitUserName) ||
      nonEmptyString(input.getSecret('GIT_USER_NAME')) ||
      input.githubDefaults?.gitUserName ||
      input.hostGitUserName,
    gitUserEmail:
      nonEmptyString(metadataIdentity?.gitUserEmail) ||
      nonEmptyString(input.getSecret('GIT_USER_EMAIL')) ||
      input.githubDefaults?.gitUserEmail ||
      input.hostGitUserEmail,
  }
}

/**
 * Sandbox environment carrying the resolved git identity.
 *
 * Emits git's own `GIT_AUTHOR_*` / `GIT_COMMITTER_*` alongside the existing
 * `GIT_USER_*` pair. The distinction matters: `GIT_USER_*` are Ficus's own names,
 * which git ignores — they only work because the sandbox image translates them
 * into `git config --global`. Global config loses to a repo-local `[user]`
 * section, and agents clone repositories themselves (see the workspace prompt),
 * so Ficus has no per-repo hook to clean one up. A single stale clone therefore
 * silently reattributed every commit made inside it, failing CLA checks on the
 * resulting PRs while all 20 sandboxes reported the correct global identity.
 *
 * git's own variables outrank every config file, local included, so this cannot
 * be shadowed. Verified: with `user.email=stale@example.invalid` set at
 * `--local` scope, `git var GIT_AUTHOR_IDENT` still resolves to the env value.
 *
 * `GIT_USER_*` are kept for the image's existing translation step and for any
 * tooling already reading them.
 */
export function gitIdentityEnv(identity: GitHubIdentity): Record<string, string> {
  const env: Record<string, string> = {}
  if (identity.gitUserName) {
    env.GIT_USER_NAME = identity.gitUserName
    env.GIT_AUTHOR_NAME = identity.gitUserName
    env.GIT_COMMITTER_NAME = identity.gitUserName
  }
  if (identity.gitUserEmail) {
    env.GIT_USER_EMAIL = identity.gitUserEmail
    env.GIT_AUTHOR_EMAIL = identity.gitUserEmail
    env.GIT_COMMITTER_EMAIL = identity.gitUserEmail
  }
  return env
}

export async function resolveDefaultGitHubIdentity(squadId?: string | null) {
  const github = await getGitHubAuthorDefaults(squadId)
  return {
    github: github ?? null,
    defaults: resolveGitHubIdentityFromMetadata({
      githubDefaults: github,
      getSecret: (key) => getSecretStore().get(key),
      hostGitUserName: readGitConfig('user.name'),
      hostGitUserEmail: readGitConfig('user.email'),
    }),
  }
}

/** Resolve git author identity independently of integration API credentials. */
export async function resolveGitHubIdentity(squadId?: string | null): Promise<GitHubIdentity> {
  const store = getSecretStore()
  let metadata: Record<string, unknown> | undefined

  if (squadId) {
    const [squad] = await db.select({ metadata: squads.metadata }).from(squads).where(eq(squads.id, squadId)).limit(1)
    metadata = squad?.metadata as Record<string, unknown> | undefined
  }

  const identity = resolveGitHubIdentityFromMetadata({
    metadata,
    githubDefaults: (await resolveDefaultGitHubIdentity(squadId)).defaults,
    getSecret: (key) => store.get(key),
  })
  return identity
}
