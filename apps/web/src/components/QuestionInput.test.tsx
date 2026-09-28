import { expect, mock, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { QuestionData } from '@ficus/shared'
import { acquireDomHarness } from '../test/domHarness'
import { QuestionInput } from './QuestionInput'

const questionData: QuestionData = {
  questions: [
    {
      id: 'branch',
      type: 'text',
      question: 'Which branch should I deploy?',
      context: 'The release build passed on **both** branches.',
      options: [{ value: 'main' }, { value: 'release/1.4', label: 'Release 1.4' }],
    },
  ],
}

test('a text question shows its context and fills the answer from a suggestion', async () => {
  const dom = await acquireDomHarness({ url: 'http://localhost/' })
  const rendered = dom.createRoot()
  const originalFetch = globalThis.fetch
  globalThis.fetch = mock(
    async () => new dom.window.Response(JSON.stringify({ enabled: false }), { status: 200 })
  ) as unknown as typeof fetch
  const onSubmit = mock((_answer: string) => {})
  try {
    await dom.act(async () =>
      rendered.root.render(
        <QueryClientProvider client={new QueryClient()}>
          <QuestionInput questionData={questionData} onSubmit={onSubmit} />
        </QueryClientProvider>
      )
    )
    const document = dom.window.document
    expect(document.body.textContent).toContain('The release build passed on both branches.')
    expect(document.querySelector('strong')?.textContent).toBe('both')

    const group = document.querySelector('[aria-label="Suggested answers"]')
    const chips = [...(group?.querySelectorAll('button') ?? [])]
    expect(chips.map((chip) => chip.textContent)).toEqual(['main', 'Release 1.4'])
    expect(chips.every((chip) => chip.getAttribute('aria-pressed') === 'false')).toBe(true)

    await dom.act(async () => chips[1]!.click())
    expect(document.querySelector('textarea')?.value).toBe('release/1.4')
    expect(chips[1]!.getAttribute('aria-pressed')).toBe('true')
    expect(document.activeElement).toBe(document.querySelector('textarea'))

    const submit = [...document.querySelectorAll('button')].find((button) => button.textContent === 'Submit Answer')
    await dom.act(async () => submit!.click())
    expect(onSubmit).toHaveBeenCalledWith('release/1.4')
  } finally {
    globalThis.fetch = originalFetch
    await dom.cleanup()
  }
})

test('select questions keep their options as choices, not suggestion chips', async () => {
  const dom = await acquireDomHarness({ url: 'http://localhost/' })
  const rendered = dom.createRoot()
  try {
    await dom.act(async () =>
      rendered.root.render(
        <QueryClientProvider client={new QueryClient()}>
          <QuestionInput
            questionData={{
              questions: [{ id: 'env', type: 'select', question: 'Where?', options: [{ value: 'staging' }] }],
            }}
            onSubmit={() => {}}
          />
        </QueryClientProvider>
      )
    )
    const document = dom.window.document
    expect(document.querySelector('[aria-label="Suggested answers"]')).toBeNull()
    expect(document.querySelectorAll('input[type="radio"]').length).toBe(2)
  } finally {
    await dom.cleanup()
  }
})
