import { notionAdapter } from './notion/adapter'
import { githubAdapter } from './github/adapter'
import { slackAdapter } from './slack/adapter'
import { linearAdapter } from './linear/adapter'
import type { OAuthProviderAdapter } from './types'

const ADAPTERS = new Map<string, OAuthProviderAdapter>([
  ['notion', notionAdapter],
  ['github', githubAdapter],
  ['slack', slackAdapter],
  ['linear', linearAdapter],
])

export function getOAuthProviderAdapter(key: string): OAuthProviderAdapter | undefined {
  return ADAPTERS.get(key)
}

export function oauthProviderKeys(): readonly string[] {
  return [...ADAPTERS.keys()].sort()
}

/** Registers a fake adapter for a test and returns a restoration callback. */
export function registerOAuthProviderAdapterForTest(adapter: OAuthProviderAdapter): () => void {
  if (process.env.NODE_ENV !== 'test') throw new Error('test-only')
  const previous = ADAPTERS.get(adapter.key)
  ADAPTERS.set(adapter.key, adapter)
  return () => {
    if (previous) ADAPTERS.set(adapter.key, previous)
    else ADAPTERS.delete(adapter.key)
  }
}

export { classifyNotionError } from './notion/adapter'
export { classifyGitHubOAuthError } from './github/adapter'
export { classifySlackError } from './slack/adapter'
export { classifyLinearOAuthError } from './linear/adapter'
export type { OAuthProviderAdapter, OAuthProviderFailure, OAuthProviderGrant, OAuthProviderTokens } from './types'
