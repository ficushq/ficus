import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  DECISION_PROVIDER_KIND_INFO,
  DECISION_PROVIDER_KINDS,
  decisionModelReadsImages,
  type DecisionAnswer,
  type DecisionProviderKind,
  type DecisionRequest,
} from '@ficus/shared'

/** One decision provider an eval run asks, however it is reached. */
export interface EvalProvider {
  id: string
  label: string
  kind: DecisionProviderKind
  model: string
  pricePerMillionInput?: number
  readsImages: boolean
  /** `purpose` attributes the ask to the eval's feature where the provider logs it (backend runs). */
  ask: (
    request: DecisionRequest,
    signal: AbortSignal,
    purpose?: string
  ) => Promise<{ answers: Record<string, DecisionAnswer>; model?: string; usage?: { inputTokens?: number } }>
}

/** Set when no instance is used, so feature modules (which import the database module) still load. */
export const PLACEHOLDER_DATABASE_URL = 'postgres://decision-evals:unused@127.0.0.1:1/unused'

const kindModel = (kind: DecisionProviderKind, model?: string) =>
  model?.trim() || DECISION_PROVIDER_KIND_INFO[kind].defaultModel

/**
 * The providers configured on the instance whose database the environment points at (the root
 * `.env`), with their keys from its secret store. Never prints a key.
 */
export async function localProviders(): Promise<EvalProvider[]> {
  if (!process.env.DATABASE_URL || process.env.DATABASE_URL === PLACEHOLDER_DATABASE_URL)
    throw new Error('No DATABASE_URL: run from a checkout with a root .env, or use --from env|backend:<label>')
  const { getSecretStore } = await import('../../secrets')
  await getSecretStore().initialize()
  const { listDecisionProviders } = await import('../store')
  const { askProvider } = await import('../service')
  return listDecisionProviders()
    .filter((provider) => provider.enabled)
    .map((provider) => ({
      id: provider.id,
      label: provider.label,
      kind: provider.kind,
      model: provider.model,
      ...(provider.pricePerMillionInput !== undefined ? { pricePerMillionInput: provider.pricePerMillionInput } : {}),
      readsImages: decisionModelReadsImages(provider),
      ask: (request, signal) => askProvider(provider, request, { signal }),
    }))
}

/**
 * Providers from environment variables, for machines without an instance:
 * `FICUS_EVAL_<KIND>_API_KEY` (JEV, OPENAI, CLOUDFLARE), `FICUS_EVAL_CLOUDFLARE_ACCOUNT_ID`,
 * `FICUS_EVAL_SYSTEMONE_URL`, and optionally `FICUS_EVAL_<KIND>_MODEL`.
 */
export async function envProviders(env: Record<string, string | undefined> = process.env): Promise<EvalProvider[]> {
  const { callDecisionProvider } = await import('../adapters')
  const providers: EvalProvider[] = []
  for (const kind of DECISION_PROVIDER_KINDS) {
    const prefix = `FICUS_EVAL_${kind.toUpperCase()}`
    const apiKey = env[`${prefix}_API_KEY`]
    const baseUrl = kind === 'systemone' ? env[`${prefix}_URL`] : undefined
    if (kind === 'systemone' ? !baseUrl : !apiKey) continue
    const accountId = env[`${prefix}_ACCOUNT_ID`]
    const model = kindModel(kind, env[`${prefix}_MODEL`])
    providers.push({
      id: `env-${kind}`,
      label: `${DECISION_PROVIDER_KIND_INFO[kind].label} (env)`,
      kind,
      model,
      readsImages: decisionModelReadsImages({ kind, model }),
      ask: (request, signal) => callDecisionProvider({ kind, model, apiKey, baseUrl, accountId }, request, { signal }),
    })
  }
  return providers
}

/**
 * The providers of a running instance, asked through its `POST /api/decisions/try` with a CLI
 * backend's credentials (`~/.ficus/cli/auth.json`), so no key leaves that instance. That route needs
 * the `provider-auth:write` permission there (the same as editing Decision Providers).
 */
export async function backendProviders(label: string): Promise<EvalProvider[]> {
  const storePath = process.env.FICUS_DEV_AUTH_STORE_PATH || join(homedir(), '.ficus', 'cli', 'auth.json')
  if (!existsSync(storePath)) throw new Error(`No CLI auth store at ${storePath}`)
  const backend = (
    JSON.parse(readFileSync(storePath, 'utf8')) as {
      backends?: Record<string, { apiUrl?: string; password?: string }>
    }
  ).backends?.[label]
  if (!backend?.apiUrl || !backend.password) throw new Error(`No CLI backend named "${label}"`)
  const base = backend.apiUrl.replace(/\/$/, '')
  const headers = { Authorization: `Bearer ${backend.password}`, 'Content-Type': 'application/json' }
  const listing = await fetch(`${base}/api/decisions`, { headers })
  if (!listing.ok) throw new Error(`${label}: GET /api/decisions answered ${listing.status}`)
  const { providers } = (await listing.json()) as {
    providers: Array<{
      id: string
      label: string
      kind: DecisionProviderKind
      model: string
      enabled: boolean
      effectivePricePerMillionInput?: number
    }>
  }
  return providers
    .filter((provider) => provider.enabled)
    .map((provider) => ({
      id: provider.id,
      label: `${provider.label} (${label})`,
      kind: provider.kind,
      model: provider.model,
      ...(provider.effectivePricePerMillionInput !== undefined
        ? { pricePerMillionInput: provider.effectivePricePerMillionInput }
        : {}),
      readsImages: decisionModelReadsImages(provider),
      ask: async (request, signal, purpose) => {
        const response = await fetch(`${base}/api/decisions/try`, {
          method: 'POST',
          headers,
          // Logged on that instance as an eval run under the eval's feature, so its spend shows.
          body: JSON.stringify({
            providerId: provider.id,
            ...request,
            source: 'eval',
            ...(purpose ? { purpose } : {}),
          }),
          signal,
        })
        const body = (await response.json()) as {
          ok?: boolean
          result?: { answers: Record<string, DecisionAnswer>; model?: string; usage?: { inputTokens?: number } }
          errors?: Array<{ error: string }>
          error?: string
        }
        if (!response.ok || !body.ok || !body.result)
          throw new Error(body.errors?.[0]?.error ?? body.error ?? `HTTP ${response.status}`)
        return body.result
      },
    }))
}

/** `local` (default), `env`, or `backend:<label>`. */
export async function resolveProviders(from = 'local'): Promise<EvalProvider[]> {
  if (from === 'local') return localProviders()
  if (from === 'env') return envProviders()
  if (from.startsWith('backend:')) return backendProviders(from.slice('backend:'.length))
  throw new Error(`Unknown provider source "${from}": use local, env or backend:<label>`)
}

/** Keep the providers a `--provider` list names, by ID or kind; all when there is no list. */
export function selectProviders(providers: EvalProvider[], wanted: string[]): EvalProvider[] {
  if (!wanted.length) return providers
  const chosen = providers.filter((provider) => wanted.includes(provider.id) || wanted.includes(provider.kind))
  const missing = wanted.filter((want) => !providers.some((provider) => provider.id === want || provider.kind === want))
  if (missing.length)
    throw new Error(
      `No provider ${missing.join(', ')}; available: ${providers.map((p) => `${p.id} (${p.kind})`).join(', ')}`
    )
  return chosen
}
