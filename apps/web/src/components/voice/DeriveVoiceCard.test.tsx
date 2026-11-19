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
