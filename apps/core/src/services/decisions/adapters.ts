import type {
  DecisionAnswer,
  DecisionImage,
  DecisionProviderKind,
  DecisionQuestion,
  DecisionRequest,
} from '@ficus/shared'

/*
 * Wire formats. SystemOne (`POST /v1/systemone`) is TypeSafe's format for Jev; Cloudflare's Clef
 * and Ollama speak it too. OpenAI's Decisions API has its own. Both answer the same three kinds of
 * question, so each adapter maps Ficus's format onto the wire and the answers back.
 */

export type DecisionFetch = (input: string, init?: RequestInit) => Promise<Response>

/** What an adapter needs to reach one provider. */
export interface DecisionEndpoint {
  kind: DecisionProviderKind
  model: string
  apiKey?: string
  baseUrl?: string
  accountId?: string
}

export interface WireAnswers {
  answers: Record<string, DecisionAnswer>
  model?: string
  usage?: { inputTokens?: number; outputTokens?: number }
}

/** A failure worth trying the next provider for; `retryable` is false for bad keys and bad requests. */
export class DecisionProviderError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean
  ) {
    super(message)
    this.name = 'DecisionProviderError'
  }
}

export async function callDecisionProvider(
  endpoint: DecisionEndpoint,
  request: DecisionRequest,
  options: { signal?: AbortSignal; fetcher?: DecisionFetch } = {}
): Promise<WireAnswers> {
  const fetcher = options.fetcher ?? fetch
  const { url, body } =
    endpoint.kind === 'openai' ? openAIRequest(endpoint, request) : systemOneRequest(endpoint, request)
  let response: Response
  try {
    response = await fetcher(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(endpoint.apiKey ? { authorization: `Bearer ${endpoint.apiKey}` } : {}),
      },
      body: JSON.stringify(body),
      signal: options.signal,
    })
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')
    throw new DecisionProviderError(timedOut ? 'Timed out' : `Could not reach it: ${message(error)}`, true)
  }
  const text = await response.text()
  if (!response.ok) {
    const retryable = response.status === 408 || response.status === 429 || response.status >= 500
    throw new DecisionProviderError(`HTTP ${response.status}${errorDetail(text)}`, retryable)
  }
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    throw new DecisionProviderError('Answered with something other than JSON', true)
  }
  return endpoint.kind === 'openai'
    ? parseOpenAI(json, request.questions)
    : parseSystemOne(endpoint.kind === 'cloudflare' ? unwrapCloudflare(json) : json, request.questions)
}

function systemOneRequest(endpoint: DecisionEndpoint, request: DecisionRequest) {
  const url =
    endpoint.kind === 'jev'
      ? 'https://api.typesafe.ai/v1/systemone'
      : endpoint.kind === 'cloudflare'
        ? `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(endpoint.accountId ?? '')}/ai/run/@cf/cloudflare/${encodeURIComponent(endpoint.model)}`
        : `${systemOneBase(endpoint.baseUrl ?? '')}/v1/systemone`
  const questions = Object.fromEntries(
    Object.entries(request.questions).map(([name, question]) => [name, systemOneQuestion(question)])
  )
  return {
    url,
    body: {
      model: endpoint.model,
      state: request.state,
      questions,
      // Clef's extension to SystemOne: up to four images as base64 data URLs.
      ...(request.images?.length ? { images: request.images.map(dataUrl) } : {}),
    },
  }
}

function dataUrl(image: DecisionImage): string {
  return `data:${image.mediaType};base64,${image.base64}`
}

function systemOneQuestion(question: DecisionQuestion) {
  switch (question.type) {
    case 'yesno':
      return { type: 'noul', instructions: question.instructions }
    case 'choice':
      return { type: 'choice', instructions: question.instructions, criteria: question.options }
    case 'score':
      return {
        type: 'score',
        instructions: question.instructions,
        criteria: question.levels.map((level) =>
          level.description ? `${level.label}: ${level.description}` : level.label
        ),
      }
  }
}

/** A SystemOne server's base URL, without a trailing `/v1` or `/v1/systemone`. */
export function systemOneBase(baseUrl: string): string {
  const parsed = new URL(baseUrl)
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('Use an http or https URL')
  return baseUrl
    .replace(/\/+$/, '')
    .replace(/\/v1\/systemone$/, '')
    .replace(/\/v1$/, '')
}

function unwrapCloudflare(json: unknown): unknown {
  const body = json as { success?: boolean; result?: unknown; errors?: Array<{ message?: string }> }
  if (body?.success === false)
    throw new DecisionProviderError(body.errors?.[0]?.message ?? 'Workers AI refused the request', false)
  return body?.result ?? json
}

function parseSystemOne(json: unknown, questions: DecisionRequest['questions']): WireAnswers {
  const body = json as {
    model?: string
    answers?: Record<string, Record<string, unknown>>
    usage?: { input_tokens?: number; output_tokens?: number }
  }
  if (!body?.answers || typeof body.answers !== 'object')
    throw new DecisionProviderError('Answered without answers', true)
  const answers: Record<string, DecisionAnswer> = {}
  for (const [name, question] of Object.entries(questions)) {
    const raw = body.answers[name]
    if (!raw || raw.type === 'refusal') {
      answers[name] = { type: 'refusal' }
      continue
    }
    if (question.type === 'yesno') {
      answers[name] = { type: 'yesno', probability: probability(raw.noul ?? raw.probability, name) }
    } else if (question.type === 'choice') {
      answers[name] = choiceAnswer(
        name,
        question,
        raw.choice,
        raw.probabilities as Record<string, unknown>,
        raw.confidence
      )
    } else {
      // SystemOne keys score probabilities by level index ("0", "1", ...).
      const byIndex = (raw.probabilities ?? {}) as Record<string, unknown>
      const probabilities = Object.fromEntries(
        question.levels.map((level, index) => [level.label, probability(byIndex[String(index)] ?? 0, name)])
      )
      answers[name] = scoreAnswer(name, question, raw.score, probabilities, raw.confidence)
    }
  }
  return {
    answers,
    ...(typeof body.model === 'string' ? { model: body.model } : {}),
    ...(body.usage ? { usage: { inputTokens: body.usage.input_tokens, outputTokens: body.usage.output_tokens } } : {}),
  }
}

function openAIRequest(endpoint: DecisionEndpoint, request: DecisionRequest) {
  const questions = Object.entries(request.questions).map(([name, question]) => {
    switch (question.type) {
      case 'yesno':
        return { type: 'predicate', name, instructions: question.instructions }
      case 'choice':
        return {
          type: 'choice',
          name,
          instructions: question.instructions,
          choices: Object.entries(question.options).map(([value, description]) => ({
            value,
            ...(description ? { description } : {}),
          })),
        }
      case 'score':
        return {
          type: 'score',
          name,
          instructions: question.instructions,
          levels: question.levels.map((level) => ({
            label: level.label,
            ...(level.description ? { description: level.description } : {}),
          })),
        }
    }
  })
  return {
    url: 'https://api.openai.com/v1/decisions',
    body: {
      model: endpoint.model,
      input: openAIInput(request),
      questions,
    },
  }
}

/**
 * The shared evidence: the state as a string, or with images a user message carrying the state as
 * `input_text` and each image as an `input_image` data URL (the endpoint takes no hosted URLs or
 * file IDs).
 */
function openAIInput(request: DecisionRequest) {
  const text = typeof request.state === 'string' ? request.state : JSON.stringify(request.state)
  if (!request.images?.length) return text
  return [
    {
      role: 'user',
      content: [
        { type: 'input_text', text },
        ...request.images.map((image) => ({ type: 'input_image', image_url: dataUrl(image) })),
      ],
    },
  ]
}

function parseOpenAI(json: unknown, questions: DecisionRequest['questions']): WireAnswers {
  const body = json as {
    model?: string
    answers?: Array<Record<string, unknown>>
    usage?: { input_tokens?: number; output_tokens?: number }
  }
  if (!Array.isArray(body?.answers)) throw new DecisionProviderError('Answered without answers', true)
  const byName = new Map(body.answers.map((answer) => [answer.name, answer]))
  const answers: Record<string, DecisionAnswer> = {}
  for (const [name, question] of Object.entries(questions)) {
    const raw = byName.get(name)
    if (!raw || raw.type === 'refusal') {
      answers[name] = { type: 'refusal' }
      continue
    }
    const list = Array.isArray(raw.probabilities) ? (raw.probabilities as Array<Record<string, unknown>>) : []
    if (question.type === 'yesno') {
      answers[name] = { type: 'yesno', probability: probability(raw.probability, name) }
    } else if (question.type === 'choice') {
      const probabilities = Object.fromEntries(list.map((entry) => [String(entry.value), entry.probability]))
      answers[name] = choiceAnswer(name, question, raw.choice, probabilities, raw.confidence)
    } else {
      const probabilities = Object.fromEntries(
        question.levels.map((level, index) => [
          level.label,
          probability(
            list.find((entry) => entry.value === index || entry.label === level.label)?.probability ?? 0,
            name
          ),
        ])
      )
      answers[name] = scoreAnswer(name, question, raw.score, probabilities, raw.confidence)
    }
  }
  return {
    answers,
    ...(typeof body.model === 'string' ? { model: body.model } : {}),
    ...(body.usage ? { usage: { inputTokens: body.usage.input_tokens, outputTokens: body.usage.output_tokens } } : {}),
  }
}

function choiceAnswer(
  name: string,
  question: Extract<DecisionQuestion, { type: 'choice' }>,
  choice: unknown,
  rawProbabilities: Record<string, unknown> | undefined,
  confidence: unknown
): DecisionAnswer {
  if (typeof choice !== 'string' || !(choice in question.options))
    throw new DecisionProviderError(`Answered '${name}' with an option it wasn't given`, true)
  const probabilities = Object.fromEntries(
    Object.keys(question.options).map((option) => [option, probability(rawProbabilities?.[option] ?? 0, name)])
  )
  return { type: 'choice', choice, probabilities, ...optionalConfidence(confidence) }
}

function scoreAnswer(
  name: string,
  question: Extract<DecisionQuestion, { type: 'score' }>,
  score: unknown,
  probabilities: Record<string, number>,
  confidence: unknown
): DecisionAnswer {
  if (typeof score !== 'number' || !Number.isFinite(score))
    throw new DecisionProviderError(`Answered '${name}' without a score`, true)
  const clamped = Math.min(question.levels.length - 1, Math.max(0, score))
  return {
    type: 'score',
    score: clamped,
    level: question.levels[Math.round(clamped)]!.label,
    probabilities,
    ...optionalConfidence(confidence),
  }
}

function probability(value: unknown, name: string): number {
  const number = typeof value === 'string' ? Number(value) : value
  if (typeof number !== 'number' || !Number.isFinite(number))
    throw new DecisionProviderError(`Answered '${name}' without a probability`, true)
  return Math.min(1, Math.max(0, number))
}

function optionalConfidence(value: unknown): { confidence?: number } {
  return typeof value === 'number' && Number.isFinite(value) ? { confidence: Math.min(1, Math.max(0, value)) } : {}
}

function errorDetail(text: string): string {
  try {
    const body = JSON.parse(text) as { error?: { message?: string } | string; errors?: Array<{ message?: string }> }
    const detail =
      typeof body.error === 'string' ? body.error : (body.error?.message ?? body.errors?.[0]?.message ?? '')
    return detail ? `: ${detail.slice(0, 200)}` : ''
  } catch {
    return ''
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
