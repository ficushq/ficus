const THINKING_LEVELS = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])

const OPENROUTER_VENDOR_EXCEPTIONS: Readonly<Record<string, string>> = {
  'openai-codex': 'openai',
  zai: 'z-ai',
}

/** Verified OpenRouter endpoint-family slugs keyed by OpenRouter model namespace. */
const OPENROUTER_ENDPOINT_BY_MODEL_VENDOR: Readonly<Record<string, string>> = {
  anthropic: 'anthropic',
  openai: 'openai',
  google: 'google-ai-studio',
  deepseek: 'streamlake',
  xiaomi: 'xiaomi',
  'x-ai': 'xai',
  'z-ai': 'z-ai',
  mistral: 'mistral',
  minimax: 'minimax',
  moonshotai: 'moonshotai',
  fireworks: 'fireworks',
  together: 'together',
  baseten: 'baseten',
  groq: 'groq',
  cerebras: 'cerebras',
  meta: 'meta',
}

/** Verified endpoint families for direct providers that may produce shadows. */
const OPENROUTER_ENDPOINT_BY_DIRECT_PROVIDER: Readonly<Record<string, string>> = {
  'amazon-bedrock': 'amazon-bedrock',
  anthropic: 'anthropic',
  google: 'google-ai-studio',
  deepseek: 'streamlake',
  xiaomi: 'xiaomi',
  'google-vertex': 'google-vertex',
  openai: 'openai',
  'openai-codex': 'openai',
  'azure-openai-responses': 'azure',
  xai: 'xai',
  zai: 'z-ai',
  mistral: 'mistral',
  minimax: 'minimax',
  moonshotai: 'moonshotai',
  fireworks: 'fireworks',
  together: 'together',
  baseten: 'baseten',
  groq: 'groq',
  cerebras: 'cerebras',
  meta: 'meta',
  'cloudflare-workers-ai': 'cloudflare',
}

export function openRouterEndpointForDirectProvider(provider: string): string | undefined {
  return OPENROUTER_ENDPOINT_BY_DIRECT_PROVIDER[provider]
}

/** Return a verified OpenRouter endpoint family for a catalog vendor/model id. */
export function openRouterEndpointForModelId(modelId: string): string | undefined {
  return OPENROUTER_ENDPOINT_BY_MODEL_VENDOR[modelId.split('/', 1)[0]]
}

export interface OpenRouterDirectSpec {
  provider: string
  modelId: string
  thinkingLevel?: string
}

/** Parse a direct-provider model spec without interpreting colons inside model ids. */
export function parseOpenRouterDirectSpec(spec: string): OpenRouterDirectSpec {
  const value = spec.trim()
  const colon = value.indexOf(':')
  const slash = value.indexOf('/')
  const separator = colon > 0 && (slash === -1 || colon < slash) ? colon : slash
  if (separator <= 0 || separator === value.length - 1) throw new Error(`Invalid direct model spec '${spec}'`)
  const provider = value.slice(0, separator).trim().toLowerCase()
  const remainder = value.slice(separator + 1).trim()
  const effortSeparator = remainder.lastIndexOf(':')
  const suffix = effortSeparator > 0 ? remainder.slice(effortSeparator + 1).trim() : ''
  const thinkingLevel = THINKING_LEVELS.has(suffix) ? suffix : undefined
  const modelId = thinkingLevel ? remainder.slice(0, effortSeparator).trim() : remainder
  if (!provider || !modelId) throw new Error(`Invalid direct model spec '${spec}'`)
  return { provider, modelId, thinkingLevel }
}

/** Derive the canonical OpenRouter vendor/model spec, preserving reasoning effort. */
export function openRouterSpecForDirect(spec: string): string {
  const { provider, modelId, thinkingLevel } = parseOpenRouterDirectSpec(spec)
  if (provider === 'openrouter') throw new Error(`Cannot derive an OpenRouter fallback from '${spec}'`)
  const vendor = OPENROUTER_VENDOR_EXCEPTIONS[provider] ?? provider
  return `openrouter:${vendor}/${modelId}${thinkingLevel ? `:${thinkingLevel}` : ''}`
}

export type OpenRouterFallbackEntry =
  { source: string; provider: string; modelId: string; fallback: string } | { source: string; error: string }

function canonicalSpec(parsed: OpenRouterDirectSpec): string {
  return `${parsed.provider}:${parsed.modelId}${parsed.thinkingLevel ? `:${parsed.thinkingLevel}` : ''}`
}

/**
 * Derive unique shadows while preserving authored order. Malformed legacy
 * entries are returned as errors so callers can warn and continue.
 */
export function deriveOpenRouterFallbackEntries(chain: string): OpenRouterFallbackEntry[] {
  const parsed: Array<{ source: string; parsed: OpenRouterDirectSpec } | { source: string; error: string }> = chain
    .split(',')
    .map((source) => source.trim())
    .filter(Boolean)
    .map((source) => {
      try {
        return { source, parsed: parseOpenRouterDirectSpec(source) }
      } catch (error) {
        return { source, error: error instanceof Error ? error.message : String(error) }
      }
    })
  const authored = new Set(
    parsed.flatMap((entry) =>
      'parsed' in entry && entry.parsed.provider === 'openrouter' ? [canonicalSpec(entry.parsed)] : []
    )
  )
  const emitted = new Set(authored)
  const entries: OpenRouterFallbackEntry[] = []
  for (const entry of parsed) {
    if ('error' in entry) {
      entries.push({ source: entry.source, error: entry.error })
      continue
    }
    if (entry.parsed.provider === 'openrouter') continue
    const fallback = openRouterSpecForDirect(entry.source)
    const fallbackParsed = parseOpenRouterDirectSpec(fallback)
    const key = canonicalSpec(fallbackParsed)
    if (emitted.has(key)) continue
    emitted.add(key)
    entries.push({
      source: entry.source,
      provider: entry.parsed.provider,
      modelId: fallbackParsed.modelId,
      fallback,
    })
  }
  return entries
}

/** Append-only shadow list, deduplicated against authored OpenRouter entries. */
export function deriveOpenRouterFallbacks(chain: string): string[] {
  return deriveOpenRouterFallbackEntries(chain).flatMap((entry) => ('fallback' in entry ? [entry.fallback] : []))
}
