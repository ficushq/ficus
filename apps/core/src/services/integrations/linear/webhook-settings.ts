import { z } from 'zod'
import { resolveOAuthCallbackUrl } from '../authorization/public-url'

export const LINEAR_WEBHOOK_SETTINGS_KEY = '__integration-webhook:linear'
export const LEGACY_LINEAR_WEBHOOK_SECRET_KEY = 'LINEAR_WEBHOOK_SECRET'

interface WebhookStore {
  get(key: string): string | undefined
  set(key: string, value: string, actor?: string): Promise<void>
}

export interface LinearWebhookSettings {
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

export function resolveLinearWebhookSecret(store: Pick<WebhookStore, 'get'>): string | null {
  return store.get(LINEAR_WEBHOOK_SETTINGS_KEY) || null
}

export function getLinearWebhookSettings(store: Pick<WebhookStore, 'get'>): LinearWebhookSettings {
  // Reuse public URL validation and preserve reverse-proxy base paths.
  const webhookUrl = resolveOAuthCallbackUrl().replace(
    /\/settings\/integrations\/oauth\/callback$/,
    '/api/webhooks/linear'
  )
  return { configured: resolveLinearWebhookSecret(store) !== null, webhookUrl }
}

export async function configureLinearWebhook(
  input: unknown,
  store: WebhookStore,
  actor: string
): Promise<LinearWebhookSettings> {
  const { secret } = inputSchema.parse(input)
  // A persisted empty value disables delivery and prevents a legacy env value
  // from being imported again on restart. Never return stored signing material.
  const settings = getLinearWebhookSettings(store)
  await store.set(LINEAR_WEBHOOK_SETTINGS_KEY, secret ?? '', actor)
  return { ...settings, configured: secret !== null }
}

/** One-time import into the integration's encrypted, non-exportable namespace. */
export async function migrateLinearWebhookSettings(
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
  const legacy = store.get(LEGACY_LINEAR_WEBHOOK_SECRET_KEY)
  if (legacy === undefined) return
  // A concurrent rotation or explicit disable wins over an upgrade import.
  await store.mutateSecret(
    LINEAR_WEBHOOK_SETTINGS_KEY,
    (current) => (current === undefined ? legacy : undefined),
    'integration-migration'
  )
  await store.refreshKey(LINEAR_WEBHOOK_SETTINGS_KEY)
  await store.delete(LEGACY_LINEAR_WEBHOOK_SECRET_KEY)
}
