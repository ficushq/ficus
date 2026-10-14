import { describe, expect, test } from 'bun:test'
import {
  decisionModelReadsImages,
  decisionRequestSchema,
  type DecisionAnswer,
  type DecisionRequest,
} from '@ficus/shared'
import { callDecisionProvider, DecisionProviderError, systemOneBase, type DecisionFetch } from './adapters'

const request: DecisionRequest = {
  state: 'Hi, my Stripe integration keeps failing for 3 days. Please refund my subscription.',
  questions: {
    department: {
      type: 'choice',
      instructions: 'Which team should handle this',
      options: { billing: 'Payment or subscription issues', technical: 'Bugs or integration problems' },
    },
    frustration: {
      type: 'score',
      instructions: 'How frustrated the customer appears',
      levels: [{ label: 'Calm' }, { label: 'Frustrated but civil' }, { label: 'Very angry', description: 'Shouting' }],
    },
    asks_refund: { type: 'yesno', instructions: 'The customer explicitly requests a refund' },
  },
}

/** Records the one request an adapter makes and answers it. */
function stub(status: number, body: unknown) {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const fetcher: DecisionFetch = async (url, init) => {
    calls.push({ url, init: init ?? {} })
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })
  }
  return { fetcher, calls, sent: () => JSON.parse(String(calls[0]!.init.body)) }
}

// TypeSafe's documented response for this request (typesafe-jev.com API reference).
const systemOneAnswer = {
  model: 'jev-1.13.0',
  answers: {
    department: {
      type: 'choice',
      choice: 'technical',
      probabilities: { technical: 0.85, billing: 0.15 },
      confidence: 0.78,
    },
    frustration: {
      type: 'score',
      score: 1.0,
      legend: { '0': 'Calm', '1': 'Frustrated but civil', '2': 'Very angry' },
      probabilities: { '0': 0.0, '1': 1.0, '2': 0.0 },
      confidence: 1.0,
    },
    asks_refund: { type: 'noul', noul: 0.91 },
  },
  usage: { input_tokens: 412, output_tokens: 67 },
}

const expectedAnswers: Record<string, DecisionAnswer> = {
  department: {
    type: 'choice',
    choice: 'technical',
    probabilities: { billing: 0.15, technical: 0.85 },
    confidence: 0.78,
  },
  frustration: {
    type: 'score',
    score: 1,
    level: 'Frustrated but civil',
    probabilities: { Calm: 0, 'Frustrated but civil': 1, 'Very angry': 0 },
    confidence: 1,
  },
  asks_refund: { type: 'yesno', probability: 0.91 },
}

describe('SystemOne (Jev, local, Cloudflare)', () => {
  test('Jev: sends TypeSafe questions and reads its answers back', async () => {
    const { fetcher, calls, sent } = stub(200, systemOneAnswer)
    const result = await callDecisionProvider({ kind: 'jev', model: 'jev-latest', apiKey: 'k' }, request, { fetcher })
    expect(calls[0]!.url).toBe('https://api.typesafe.ai/v1/systemone')
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe('Bearer k')
    expect(sent()).toEqual({
      model: 'jev-latest',
      state: request.state,
      questions: {
        department: {
          type: 'choice',
          instructions: 'Which team should handle this',
          criteria: { billing: 'Payment or subscription issues', technical: 'Bugs or integration problems' },
        },
        frustration: {
          type: 'score',
          instructions: 'How frustrated the customer appears',
          criteria: ['Calm', 'Frustrated but civil', 'Very angry: Shouting'],
        },
        asks_refund: { type: 'noul', instructions: 'The customer explicitly requests a refund' },
      },
    })
    expect(result).toEqual({
      answers: expectedAnswers,
      model: 'jev-1.13.0',
      usage: { inputTokens: 412, outputTokens: 67 },
    })
  })

  test('a local server is asked at its /v1/systemone, without a key when it has none', async () => {
    const { fetcher, calls } = stub(200, systemOneAnswer)
    await callDecisionProvider({ kind: 'systemone', model: 'clef', baseUrl: 'http://localhost:11434/v1/' }, request, {
      fetcher,
    })
    expect(calls[0]!.url).toBe('http://localhost:11434/v1/systemone')
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBeUndefined()
  })

  test("Cloudflare: Workers AI's account URL, and its result envelope", async () => {
    const { fetcher, calls } = stub(200, { success: true, result: systemOneAnswer, errors: [] })
    const result = await callDecisionProvider(
      { kind: 'cloudflare', model: 'clef-flash', apiKey: 't', accountId: 'acc 1' },
      request,
      { fetcher }
    )
    expect(calls[0]!.url).toBe('https://api.cloudflare.com/client/v4/accounts/acc%201/ai/run/@cf/cloudflare/clef-flash')
    expect(result.answers).toEqual(expectedAnswers)
  })
})

describe('OpenAI Decisions', () => {
  test('sends predicate/choice/score questions as a list and reads the list of answers back', async () => {
    const { fetcher, calls, sent } = stub(200, {
      answers: [
        {
          type: 'choice',
          name: 'department',
          choice: 'billing',
          probabilities: [
            { value: 'billing', probability: 0.95 },
            { value: 'technical', probability: 0.05 },
          ],
          confidence: 0.93,
        },
        {
          type: 'score',
          name: 'frustration',
          score: 1.6,
          probabilities: [
            { value: 0, label: 'Calm', probability: 0.1 },
            { value: 1, label: 'Frustrated but civil', probability: 0.2 },
            { value: 2, label: 'Very angry', probability: 0.7 },
          ],
          confidence: 0.55,
        },
        { type: 'refusal', name: 'asks_refund' },
      ],
    })
    const result = await callDecisionProvider({ kind: 'openai', model: 'gpt-6-luna', apiKey: 'sk' }, request, {
      fetcher,
    })
    expect(calls[0]!.url).toBe('https://api.openai.com/v1/decisions')
    expect(sent()).toEqual({
      model: 'gpt-6-luna',
      input: request.state,
      questions: [
        {
          type: 'choice',
          name: 'department',
          instructions: 'Which team should handle this',
          choices: [
            { value: 'billing', description: 'Payment or subscription issues' },
            { value: 'technical', description: 'Bugs or integration problems' },
          ],
        },
        {
          type: 'score',
          name: 'frustration',
          instructions: 'How frustrated the customer appears',
          levels: [
            { label: 'Calm' },
            { label: 'Frustrated but civil' },
            { label: 'Very angry', description: 'Shouting' },
          ],
        },
        { type: 'predicate', name: 'asks_refund', instructions: 'The customer explicitly requests a refund' },
      ],
    })
    expect(result.answers).toEqual({
      department: {
        type: 'choice',
        choice: 'billing',
        probabilities: { billing: 0.95, technical: 0.05 },
        confidence: 0.93,
      },
      frustration: {
        type: 'score',
        score: 1.6,
        level: 'Very angry',
        probabilities: { Calm: 0.1, 'Frustrated but civil': 0.2, 'Very angry': 0.7 },
        confidence: 0.55,
      },
      asks_refund: { type: 'refusal' },
    })
  })

  test('JSON state is sent as text', async () => {
    const { fetcher, sent } = stub(200, { answers: [{ type: 'predicate', name: 'q', probability: 0.2 }] })
    await callDecisionProvider(
      { kind: 'openai', model: 'gpt-6-luna', apiKey: 'sk' },
      { state: { title: 'Hi' }, questions: { q: { type: 'yesno', instructions: 'Is it a greeting?' } } },
      { fetcher }
    )
    expect(sent().input).toBe('{"title":"Hi"}')
  })
})

describe('images', () => {
  const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
  const withImages: DecisionRequest = {
    state: { note: 'Dropped into Ficus' },
    questions: { q: { type: 'yesno', instructions: 'Is it a bug?' } },
    images: [
      { mediaType: 'image/png', base64: PNG },
      { mediaType: 'image/webp', base64: 'UklGRg==' },
    ],
  }

  test('SystemOne (Clef) sends them as base64 data URLs in images, beside the state', async () => {
    for (const endpoint of [
      { kind: 'systemone' as const, model: 'clef', baseUrl: 'http://localhost:11434' },
      { kind: 'cloudflare' as const, model: 'clef', apiKey: 't', accountId: 'a' },
    ]) {
      const answer = { answers: { q: { type: 'noul', noul: 0.8 } } }
      const { fetcher, sent } = stub(200, endpoint.kind === 'cloudflare' ? { success: true, result: answer } : answer)
      await callDecisionProvider(endpoint, withImages, { fetcher })
      expect(sent()).toEqual({
        model: 'clef',
        state: { note: 'Dropped into Ficus' },
        questions: { q: { type: 'noul', instructions: 'Is it a bug?' } },
        images: [`data:image/png;base64,${PNG}`, 'data:image/webp;base64,UklGRg=='],
      })
    }
  })

  test('without images, SystemOne requests carry no images field', async () => {
    const { fetcher, sent } = stub(200, systemOneAnswer)
    await callDecisionProvider({ kind: 'jev', model: 'jev-latest', apiKey: 'k' }, request, { fetcher })
    expect('images' in sent()).toBe(false)
  })

  test('OpenAI sends a user message with the state as input_text and each image as an input_image data URL', async () => {
    const { fetcher, sent } = stub(200, { answers: [{ type: 'predicate', name: 'q', probability: 0.8 }] })
    const result = await callDecisionProvider({ kind: 'openai', model: 'gpt-6-luna', apiKey: 'sk' }, withImages, {
      fetcher,
    })
    expect(sent().input).toEqual([
      {
        role: 'user',
        content: [
          { type: 'input_text', text: '{"note":"Dropped into Ficus"}' },
          { type: 'input_image', image_url: `data:image/png;base64,${PNG}` },
          { type: 'input_image', image_url: 'data:image/webp;base64,UklGRg==' },
        ],
      },
    ])
    expect(result.answers).toEqual({ q: { type: 'yesno', probability: 0.8 } })
  })

  test('which models read images', () => {
    expect(decisionModelReadsImages({ kind: 'jev', model: 'jev-latest' })).toBe(false)
    expect(decisionModelReadsImages({ kind: 'cloudflare', model: 'clef-flash' })).toBe(true)
    expect(decisionModelReadsImages({ kind: 'openai', model: 'gpt-6-luna' })).toBe(true)
    for (const model of ['clef', 'clef-flash', 'clef:27b', 'Cloudflare/clef', 'hf.co/cloudflare/clef-flash-GGUF'])
      expect([model, decisionModelReadsImages({ kind: 'systemone', model })]).toEqual([model, true])
    for (const model of ['jev-local', 'qwen3:8b', 'clefable'])
      expect([model, decisionModelReadsImages({ kind: 'systemone', model })]).toEqual([model, false])
  })

  test('requests take at most four PNG, JPEG or WebP images of up to 4 MB each', () => {
    const image = { mediaType: 'image/png' as const, base64: PNG }
    expect(decisionRequestSchema.safeParse({ ...withImages, images: Array(4).fill(image) }).success).toBe(true)
    expect(decisionRequestSchema.safeParse({ ...withImages, images: Array(5).fill(image) }).success).toBe(false)
    expect(
      decisionRequestSchema.safeParse({ ...withImages, images: [{ mediaType: 'image/gif', base64: PNG }] }).success
    ).toBe(false)
    const big = 'A'.repeat(Math.ceil(((4 * 1024 * 1024 + 3) * 4) / 3))
    expect(
      decisionRequestSchema.safeParse({ ...withImages, images: [{ mediaType: 'image/png', base64: big }] }).success
    ).toBe(false)
    expect(
      decisionRequestSchema.safeParse({ ...withImages, images: [{ mediaType: 'image/png', base64: `data:${PNG}` }] })
        .success
    ).toBe(false)
  })
})

describe('failures', () => {
  const yesno: DecisionRequest = { state: 'x', questions: { q: { type: 'yesno', instructions: 'Is it?' } } }

  test('bad keys are not worth retrying; overload and outages are', async () => {
    const unauthorized = stub(401, { error: { message: 'Invalid API key' } })
    const error = await callDecisionProvider({ kind: 'jev', model: 'jev-latest', apiKey: 'k' }, yesno, {
      fetcher: unauthorized.fetcher,
    }).catch((e) => e)
    expect(error).toBeInstanceOf(DecisionProviderError)
    expect(error.message).toBe('HTTP 401: Invalid API key')
    expect(error.retryable).toBe(false)
    const overloaded = await callDecisionProvider({ kind: 'jev', model: 'jev-latest', apiKey: 'k' }, yesno, {
      fetcher: stub(529, '').fetcher,
    }).catch((e) => e)
    expect(overloaded.retryable).toBe(true)
  })

  test('an answer outside the options, or not JSON, is a failure rather than a guess', async () => {
    const choice: DecisionRequest = {
      state: 'x',
      questions: { c: { type: 'choice', instructions: 'Which?', options: { a: '', b: '' } } },
    }
    const offList = stub(200, { answers: { c: { type: 'choice', choice: 'zzz', probabilities: {} } } })
    expect(
      (
        await callDecisionProvider({ kind: 'jev', model: 'm', apiKey: 'k' }, choice, {
          fetcher: offList.fetcher,
        }).catch((e) => e)
      ).message
    ).toBe("Answered 'c' with an option it wasn't given")
    const html = stub(200, '<html>')
    expect(
      (
        await callDecisionProvider({ kind: 'jev', model: 'm', apiKey: 'k' }, yesno, { fetcher: html.fetcher }).catch(
          (e) => e
        )
      ).message
    ).toBe('Answered with something other than JSON')
  })

  test("Cloudflare's success: false carries its error", async () => {
    const { fetcher } = stub(200, { success: false, errors: [{ message: 'Model not found' }] })
    const error = await callDecisionProvider({ kind: 'cloudflare', model: 'x', apiKey: 't', accountId: 'a' }, yesno, {
      fetcher,
    }).catch((e) => e)
    expect(error.message).toBe('Model not found')
    expect(error.retryable).toBe(false)
  })

  test('local server URLs are normalized, and only http(s) is accepted', () => {
    expect(systemOneBase('http://localhost:11434')).toBe('http://localhost:11434')
    expect(systemOneBase('http://localhost:8000/v1/systemone')).toBe('http://localhost:8000')
    expect(() => systemOneBase('file:///etc/passwd')).toThrow()
  })
})
