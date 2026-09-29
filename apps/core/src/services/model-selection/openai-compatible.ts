export type ProviderFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>
export interface ProviderCapabilities {
  tools: boolean
  contextWindow?: number
  probedAt: string
}
export interface ProbeResult {
  models: string[]
  capabilities: ProviderCapabilities
}
const LOCAL_PORTS = [8080, 11434, 1234, 8000] as const

function v1Base(baseUrl: string): string {
  const parsed = new URL(baseUrl)
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('baseUrl must use http or https')
  return baseUrl.replace(/\/$/, '').replace(/\/v1$/, '') + '/v1'
}
function headers(apiKey?: string): HeadersInit {
  return { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) }
}

/** Probe model discovery and an actual tool-call response before an account is usable. */
export async function probeOpenAICompatible(input: {
  baseUrl: string
  model: string
  apiKey?: string
  timeoutMs?: number
  fetcher?: ProviderFetch
}): Promise<ProbeResult> {
  const fetcher = input.fetcher ?? fetch
  const signal = AbortSignal.timeout(input.timeoutMs ?? 3_000)
  const base = v1Base(input.baseUrl)
  const discovered = await fetcher(`${base}/models`, { headers: headers(input.apiKey), signal })
  if (!discovered.ok) throw new Error(`Model discovery failed (${discovered.status})`)
  const body = (await discovered.json()) as { data?: Array<{ id?: string; context_window?: number }> }
  const models = (body.data ?? []).flatMap((entry) => (entry.id ? [entry.id] : []))
  if (!models.includes(input.model)) throw new Error(`Model '${input.model}' was not advertised by the server`)

  const completion = await fetcher(`${base}/chat/completions`, {
    method: 'POST',
    headers: headers(input.apiKey),
    signal,
    body: JSON.stringify({
      model: input.model,
      messages: [{ role: 'user', content: 'Call ficus_probe now.' }],
      tools: [
        {
          type: 'function',
          function: {
            name: 'ficus_probe',
            description: 'Capability probe',
            parameters: { type: 'object', properties: {} },
          },
        },
      ],
      tool_choice: 'required',
      max_tokens: 32,
    }),
  })
  if (!completion.ok) throw new Error(`Tool capability probe failed (${completion.status})`)
  const completionBody = (await completion.json()) as { choices?: Array<{ message?: { tool_calls?: unknown[] } }> }
  const advertised = body.data?.find((entry) => entry.id === input.model)
  return {
    models,
    capabilities: {
      tools: Boolean(completionBody.choices?.[0]?.message?.tool_calls?.length),
      ...(advertised?.context_window ? { contextWindow: advertised.context_window } : {}),
      probedAt: new Date().toISOString(),
    },
  }
}

/** Explicitly probe the fixed localhost allowlist; callers decide when to invoke it. */
export async function detectLocalServers(
  input: { fetcher?: ProviderFetch; timeoutMs?: number } = {}
): Promise<Array<{ baseUrl: string; models: string[] }>> {
  const fetcher = input.fetcher ?? fetch
  const results = await Promise.all(
    LOCAL_PORTS.map(async (port) => {
      const baseUrl = `http://localhost:${port}/v1`
      try {
        const response = await fetcher(`${baseUrl}/models`, { signal: AbortSignal.timeout(input.timeoutMs ?? 750) })
        if (!response.ok) return null
        const body = (await response.json()) as { data?: Array<{ id?: string }> }
        return { baseUrl, models: (body.data ?? []).flatMap((entry) => (entry.id ? [entry.id] : [])) }
      } catch {
        return null
      }
    })
  )
  return results.filter((result): result is { baseUrl: string; models: string[] } => result !== null)
}
