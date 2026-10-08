import { randomUUID } from 'node:crypto'
import {
  DECISION_PROVIDER_KIND_INFO,
  DECISION_PROVIDER_KINDS,
  decisionRoutingSchema,
  type DecisionProviderKind,
  type DecisionProviderView,
  type DecisionRouting,
} from '@ficus/shared'
import { getSecretStore } from '../secrets'
import { getSettingsStore } from '../settings'

/*
 * Decision providers live apart from AI Providers' agent accounts (PROVIDER_AUTH_DATA): they are
 * not chat models, so the agent model runtime, tiers and fallback never see them. Keys stay in the
 * secret store; which providers each purpose asks is a plain setting.
 */

export const DECISION_PROVIDERS_KEY = 'DECISION_PROVIDERS'
export const DECISION_ROUTING_KEY = 'DECISION_ROUTING'

export interface StoredDecisionProvider {
  id: string
  kind: DecisionProviderKind
  label: string
  model: string
  enabled: boolean
  baseUrl?: string
  accountId?: string
  apiKey?: string
}

interface ProviderDocument {
  version: 1
  providers: StoredDecisionProvider[]
}

export function listDecisionProviders(): StoredDecisionProvider[] {
  const raw = getSecretStore().get(DECISION_PROVIDERS_KEY)
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as Partial<ProviderDocument>
    return (parsed.providers ?? []).filter(
      (provider): provider is StoredDecisionProvider =>
        typeof provider?.id === 'string' && DECISION_PROVIDER_KINDS.includes(provider.kind)
    )
  } catch {
    return []
  }
}

export function getDecisionProvider(id: string): StoredDecisionProvider | undefined {
  return listDecisionProviders().find((provider) => provider.id === id)
}

export function decisionProviderView(provider: StoredDecisionProvider): DecisionProviderView {
  return {
    id: provider.id,
    kind: provider.kind,
    label: provider.label,
    model: provider.model,
    enabled: provider.enabled,
    ...(provider.baseUrl ? { baseUrl: provider.baseUrl } : {}),
    ...(provider.accountId ? { accountId: provider.accountId } : {}),
    hasApiKey: Boolean(provider.apiKey),
  }
}

let writes: Promise<unknown> = Promise.resolve()

/** Read-modify-write the provider list, one write at a time. */
async function mutateProviders<T>(change: (providers: StoredDecisionProvider[]) => T): Promise<T> {
  const run = writes.then(async () => {
    const providers = listDecisionProviders()
    const result = change(providers)
    const document: ProviderDocument = { version: 1, providers }
    await getSecretStore().set(DECISION_PROVIDERS_KEY, JSON.stringify(document), 'decisions')
    return result
  })
  writes = run.catch(() => undefined)
  return run
}

export interface NewDecisionProvider {
  kind: DecisionProviderKind
  label?: string
  model?: string
  baseUrl?: string
  accountId?: string
  apiKey?: string
}

export async function addDecisionProvider(input: NewDecisionProvider): Promise<StoredDecisionProvider> {
  const provider: StoredDecisionProvider = {
    id: `${input.kind}-${randomUUID().slice(0, 8)}`,
    kind: input.kind,
    label: input.label?.trim() || DECISION_PROVIDER_KIND_INFO[input.kind].label,
    model: input.model?.trim() || DECISION_PROVIDER_KIND_INFO[input.kind].defaultModel,
    enabled: true,
    ...(input.baseUrl ? { baseUrl: input.baseUrl.trim() } : {}),
    ...(input.accountId ? { accountId: input.accountId.trim() } : {}),
    ...(input.apiKey?.trim() ? { apiKey: input.apiKey.trim() } : {}),
  }
  await mutateProviders((providers) => providers.push(provider))
  // A first provider answers every purpose until the owner orders them.
  const routing = getDecisionRouting()
  if (!routing.default.length) await setDecisionRouting({ ...routing, default: [provider.id] }, 'decisions')
  return provider
}

export async function updateDecisionProvider(
  id: string,
  patch: Partial<Pick<StoredDecisionProvider, 'label' | 'model' | 'enabled' | 'baseUrl' | 'accountId' | 'apiKey'>>
): Promise<StoredDecisionProvider | undefined> {
  return mutateProviders((providers) => {
    const provider = providers.find((entry) => entry.id === id)
    if (!provider) return undefined
    if (patch.label !== undefined) provider.label = patch.label.trim() || provider.label
    if (patch.model !== undefined) provider.model = patch.model.trim() || provider.model
    if (patch.enabled !== undefined) provider.enabled = patch.enabled
    if (patch.baseUrl !== undefined) provider.baseUrl = patch.baseUrl.trim() || undefined
    if (patch.accountId !== undefined) provider.accountId = patch.accountId.trim() || undefined
    // An empty key keeps the stored one; only a new key replaces it.
    if (patch.apiKey?.trim()) provider.apiKey = patch.apiKey.trim()
    return provider
  })
}

export async function removeDecisionProvider(id: string): Promise<boolean> {
  const removed = await mutateProviders((providers) => {
    const index = providers.findIndex((provider) => provider.id === id)
    if (index < 0) return false
    providers.splice(index, 1)
    return true
  })
  if (removed) {
    const routing = getDecisionRouting()
    const without = (ids: string[]) => ids.filter((entry) => entry !== id)
    await setDecisionRouting(
      {
        ...routing,
        default: without(routing.default),
        purposes: Object.fromEntries(Object.entries(routing.purposes).map(([purpose, ids]) => [purpose, without(ids)])),
      },
      'decisions'
    )
  }
  return removed
}

export function getDecisionRouting(): DecisionRouting {
  const raw = getSettingsStore().getStoredValue(DECISION_ROUTING_KEY)
  try {
    return decisionRoutingSchema.parse(raw ? JSON.parse(raw) : {})
  } catch {
    return decisionRoutingSchema.parse({})
  }
}

export async function setDecisionRouting(routing: DecisionRouting, actor: string): Promise<DecisionRouting> {
  const parsed = decisionRoutingSchema.parse(routing)
  await getSettingsStore().set(DECISION_ROUTING_KEY, JSON.stringify(parsed), actor)
  return parsed
}
