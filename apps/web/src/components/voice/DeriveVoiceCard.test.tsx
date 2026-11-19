import { expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { DeriveVoiceCard } from './DeriveVoiceCard'
import { acquireDomHarness } from '../../test/domHarness'

const failures = [
  ['derivation_github_unavailable', 'GitHub is unavailable'],
  ['derivation_login_not_visible', 'The GitHub login was not found or is not visible'],
  ['derivation_too_few_samples', 'Too few samples: kept 2 of 10 collected; at least 8 are required.'],
  ['derivation_invalid_output', 'overlapped private sample text'],
  ['derivation_model_unavailable', 'The derivation model is unavailable'],
] as const

for (const [code, sentence] of failures) {
  test(`derives another login without confirmation and displays ${code} through the real client`, async () => {
    const dom = await acquireDomHarness({ url: 'http://localhost' })
    const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
    const requests: Array<{ url: string; body: unknown }> = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (input, init) => {
      requests.push({ url: String(input), body: JSON.parse(String(init?.body)) })
      return Response.json(
        { error: code, reason: 'private_text_in_base', counts: { kept: 2, collected: 10 }, minimum: 8 },
        { status: 422 }
      )
    }) as typeof fetch
    try {
      const { root, container } = dom.createRoot()
      await dom.act(async () =>
        root.render(
          <QueryClientProvider client={client}>
            <DeriveVoiceCard squadId="fixture-squad" linkedLogin={null} />
          </QueryClientProvider>
        )
      )
      const input = container.querySelector<HTMLInputElement>('[aria-label="GitHub login"]')!
      await dom.act(async () => {
        Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(
          input,
          'another-login'
        )
        input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
      })
      await dom.act(async () => {
        const button = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
          (b) => b.textContent === 'Derive'
        )!
        button.click()
        await new Promise((resolve) => setTimeout(resolve, 20))
      })
      expect(Boolean(container.querySelector('[role="alertdialog"]'))).toBe(false)
      expect(requests).toEqual([
        {
          url: 'http://localhost/api/squads/fixture-squad/voice/derive',
          body: { login: 'another-login', filters: {} },
        },
      ])
      expect(container.querySelector('details code')?.textContent).toBe(code)
      expect([...container.querySelectorAll('p')].some((p) => p.textContent?.includes(code))).toBe(false)
      expect(container.textContent).toContain(sentence)
      expect(container.textContent).not.toContain('Ficus is temporarily unavailable')
    } finally {
      globalThis.fetch = originalFetch
      await dom.cleanup()
      client.clear()
    }
  })
}

test('partial progress is accessible, cancellation fences a late result and never saves', async () => {
  const dom = await acquireDomHarness({ url: 'http://localhost' })
  const originalFetch = globalThis.fetch
  let stream!: ReadableStreamDefaultController<Uint8Array>
  let requestSignal: AbortSignal | undefined
  let used = false
  let saved = false
  const encoder = new TextEncoder()
  const send = (event: unknown) =>
    stream.enqueue(encoder.encode(`event: derivation\ndata: ${JSON.stringify(event)}\n\n`))
  globalThis.fetch = (async (_, init) => {
    requestSignal = init?.signal ?? undefined
    return new Response(
      new ReadableStream({
        start(c) {
          stream = c
        },
      }),
      { headers: { 'Content-Type': 'text/event-stream' } }
    )
  }) as typeof fetch
  try {
    const { root, container } = dom.createRoot()
    await dom.act(async () =>
      root.render(
        <DeriveVoiceCard
          squadId="fixture"
          linkedLogin="octo"
          onUseDraft={() => {
            used = true
          }}
          onSaveAsProfile={() => {
            saved = true
          }}
        />
      )
    )
    await dom.act(async () => {
      ;[...container.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'Derive')!.click()
    })
    await dom.act(async () => {
      send({ version: 1, runId: 'fixture', seq: 1, type: 'started' })
      send({
        version: 1,
        runId: 'fixture',
        seq: 2,
        type: 'repositories',
        repositories: [{ name: 'example/private-library', activity: 'activity_read' }],
      })
    })
    expect(container.querySelector('[aria-label="Voice derivation progress"]')).not.toBeNull()
    expect(container.querySelector('[role="status"]')?.getAttribute('aria-live')).toBe('polite')
    expect(container.textContent).toContain('example/private-library')
    expect(container.querySelector<HTMLInputElement>('[aria-label="GitHub login"]')!.disabled).toBe(true)
    expect(container.textContent).not.toContain('Use this draft')
    await dom.act(async () => {
      ;[...container.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'Cancel')!.click()
    })
    expect(requestSignal!.aborted).toBe(true)
    expect(container.textContent).toContain('Cancelled. Nothing was saved.')
    expect(used || saved).toBe(false)
  } finally {
    globalThis.fetch = originalFetch
    await dom.cleanup()
  }
})
