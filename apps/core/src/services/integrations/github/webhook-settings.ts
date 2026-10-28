import { z } from 'zod'
import { resolveOAuthCallbackUrl } from '../authorization/public-url'

export const GITHUB_WEBHOOK_SETTINGS_KEY = '__integration-webhook:github'
export const LEGACY_GITHUB_WEBHOOK_SECRET_KEY = 'GITHUB_WEBHOOK_SECRET'

interface WebhookStore {
  get(key: string): string | undefined
  set(key: string, value: string, actor?: string): Promise<void>
}

export interface GitHubWebhookSettings {
  configured: boolean
  webhookUrl: string
}

const inputSchema = z.strictObject({
  secret: z
    .string()
    .min(1)
    .max(16_384)
    .refine((value) => value.trim().length > 0)
    .nullable(),
})

export function resolveGitHubWebhookSecret(store: Pick<WebhookStore, 'get'>): string | null {
  return store.get(GITHUB_WEBHOOK_SETTINGS_KEY) || null
}

export function getGitHubWebhookSettings(store: Pick<WebhookStore, 'get'>): GitHubWebhookSettings {
  // Reuse public URL validation and preserve reverse-proxy base paths.
  const webhookUrl = resolveOAuthCallbackUrl().replace(
    /\/settings\/integrations\/oauth\/callback$/,
    '/api/webhooks/github'
  )
  return { configured: resolveGitHubWebhookSecret(store) !== null, webhookUrl }
}

export async function configureGitHubWebhook(
  input: unknown,
  store: WebhookStore,
  actor: string
): Promise<GitHubWebhookSettings> {
  const { secret } = inputSchema.parse(input)
  // A persisted empty value disables delivery and prevents a legacy env value
  // from being imported again on restart. Never return stored signing material.
  const settings = getGitHubWebhookSettings(store)
  await store.set(GITHUB_WEBHOOK_SETTINGS_KEY, secret ?? '', actor)
  return { ...settings, configured: secret !== null }
}

/** One-time import into the integration's encrypted, non-exportable namespace. */
export async function migrateGitHubWebhookSettings(
  store: WebhookStore & {
    mutateSecret(
      key: string,
      mutate: (current: string | undefined) => string | undefined,
      actor?: string
    ): Promise<void>
    refreshKey(key: string): Promise<void>
    delete(key: string): Promise<void>
  }
): Promise<void> {
  const legacy = store.get(LEGACY_GITHUB_WEBHOOK_SECRET_KEY)
  if (legacy === undefined) return
  // A concurrent rotation or explicit disable wins over an upgrade import.
  await store.mutateSecret(
    GITHUB_WEBHOOK_SETTINGS_KEY,
    (current) => (current === undefined ? legacy : undefined),
    'integration-migration'
  )
  await store.refreshKey(GITHUB_WEBHOOK_SETTINGS_KEY)
  await store.delete(LEGACY_GITHUB_WEBHOOK_SECRET_KEY)
}
