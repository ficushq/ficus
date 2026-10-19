import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expandTilde } from '@ficus/shared/node'
import { getHomeDir } from '../../../lib/utils/home'
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
    throw new Error('No DATABASE_URL: run from a checkout with a root .env, or use --from worker|env|backend:<label>')
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

/** Use only the worker's injected identity; never consult a password or saved login. */
export async function workerProviders(): Promise<EvalProvider[]> {
  if (!process.env.FICUS_API_URL) throw new Error('Worker evaluations require FICUS_API_URL; no backend fallback')
  if (!process.env.FICUS_TOKEN) throw new Error('Worker evaluations require FICUS_TOKEN; no human login fallback')
  return remoteProviders(process.env.FICUS_API_URL, process.env.FICUS_TOKEN, 'worker')
}

/** Explicit operator backend selection, independent of ambient worker credentials. */
export async function backendProviders(label: string): Promise<EvalProvider[]> {
  if (process.env.FICUS_AGENT_CONTEXT === '1' || process.env.FICUS_WEBHOOK_CONTEXT === '1')
    throw new Error('Use --from worker with the injected identity, not a saved human backend')
  const storePath = expandTilde(
    process.env.FICUS_AUTH_STORE || process.env.FICUS_DEV_AUTH_STORE_PATH || join(getHomeDir(), 'cli', 'auth.json')
  )
  if (!existsSync(storePath)) throw new Error('No CLI auth store; select --from worker for injected authentication')
  let backend: { apiUrl?: string; password?: string } | undefined
  try {
    backend = JSON.parse(readFileSync(storePath, 'utf8')).backends?.[label]
  } catch {
    throw new Error('Invalid CLI auth store')
  }
  if (typeof backend?.apiUrl !== 'string' || typeof backend.password !== 'string' || !backend.password)
    throw new Error('No valid CLI backend with that label')
  return remoteProviders(backend.apiUrl, backend.password, label)
}

/** A credential is sent only to the explicitly selected HTTP(S) API, never across redirects. */
function apiBase(apiUrl: string): string {
  try {
    const url = new URL(apiUrl)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
      throw new Error()
    return url.toString().replace(/\/+$/, '')
  } catch {
    throw new Error('Invalid Ficus API URL (expected HTTP(S), without credentials, query or fragment)')
  }
}

async function remoteProviders(apiUrl: string, token: string, label: string): Promise<EvalProvider[]> {
  const base = apiBase(apiUrl)
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
  // Do not surface response bodies, URL-bearing transport errors or auth-store parse excerpts.
  async function send(init: RequestInit): Promise<Response> {
    let response: Response
    try {
      response = await fetch(`${base}/api/decisions/evaluate`, { ...init, headers, redirect: 'error' })
    } catch {
      throw new Error('Could not reach the evaluation API (or request aborted)')
    }
    if (!response.ok) throw new Error(`Evaluation API answered HTTP ${response.status}`)
    return response
  }
  const listing = await send({ signal: AbortSignal.timeout(15_000) })
  let providers: Array<{
    id: string
    label: string
    kind: DecisionProviderKind
    model: string
    enabled: boolean
    effectivePricePerMillionInput?: number | null
  }>
  try {
    providers = (await listing.json()).providers
    if (!Array.isArray(providers)) throw new Error()
  } catch {
    throw new Error('Invalid evaluation provider listing')
  }
  return providers
    .filter((provider) => provider.enabled)
    .map((provider) => ({
      id: provider.id,
      label: `${provider.label} (${label})`,
      kind: provider.kind,
      model: provider.model,
      ...(provider.effectivePricePerMillionInput != null
        ? { pricePerMillionInput: provider.effectivePricePerMillionInput }
        : {}),
      readsImages: decisionModelReadsImages(provider),
      ask: async (request, signal, purpose) => {
        const response = await send({
          method: 'POST',
          body: JSON.stringify({ ...request, providerId: provider.id, purpose }),
          signal,
        })
        try {
          const body = (await response.json()) as {
            ok?: boolean
            result?: { answers: Record<string, DecisionAnswer>; model?: string; usage?: { inputTokens?: number } }
          }
          if (!body.ok || !body.result) throw new Error()
          return body.result
        } catch {
          throw new Error('Evaluation provider did not return an answer')
        }
      },
    }))
}

export function defaultProviderSource(): 'worker' | 'local' {
  return process.env.FICUS_AGENT_CONTEXT === '1' || process.env.FICUS_WEBHOOK_CONTEXT === '1' ? 'worker' : 'local'
}

/** Explicit sources never fall back to a different host, database or credential. */
export async function resolveProviders(from: string = defaultProviderSource()): Promise<EvalProvider[]> {
  if (from === 'local') return localProviders()
  if (from === 'env') return envProviders()
  if (from === 'worker') return workerProviders()
  if (from.startsWith('backend:')) return backendProviders(from.slice('backend:'.length))
  throw new Error('Unknown provider source: use local, env, worker or backend:<label>')
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
