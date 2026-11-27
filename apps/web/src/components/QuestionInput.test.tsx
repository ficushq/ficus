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
    // Rounded rectangles, not pills, so long suggestions that wrap still look right.
    expect(
      chips.every((chip) => chip.classList.contains('rounded-md') && !chip.classList.contains('rounded-full'))
    ).toBe(true)

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
  const dom = await acquireDomHarness({ url: 'http://localhost/', api: { '/api/voice/status': { enabled: false } } })
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

async function renderQuestion(data: QuestionData, onSubmit: (answer: string) => void = () => {}) {
  const dom = await acquireDomHarness({ url: 'http://localhost/', api: { '/api/voice/status': { enabled: false } } })
  const rendered = dom.createRoot()
  await dom.act(async () =>
    rendered.root.render(
      <QueryClientProvider client={new QueryClient()}>
        <QuestionInput questionData={data} onSubmit={onSubmit} />
      </QueryClientProvider>
    )
  )
  return dom
}

test('a select question marks the recommended option and its reason without preselecting it', async () => {
  const onSubmit = mock((_answer: string) => {})
  const dom = await renderQuestion(
    {
      questions: [
        {
          id: 'env',
          type: 'select',
          question: 'Where should I deploy?',
          options: [
            { value: 'staging', label: 'Staging' },
            { value: 'prod', label: 'Production', recommended: true, reason: 'The release build passed there.' },
          ],
        },
      ],
    },
    onSubmit
  )
  try {
    const document = dom.window.document
    const labels = [...document.querySelectorAll('label')].filter((label) => label.querySelector('input[type="radio"]'))
    expect(labels.map((label) => label.textContent)).toEqual([
      'Staging',
      'ProductionRecommendedThe release build passed there.',
      'Other',
    ])
    const radios = [...document.querySelectorAll<HTMLInputElement>('input[type="radio"]')]
    expect(radios.every((radio) => !radio.checked)).toBe(true)
    const reason = document.getElementById(radios[1]!.getAttribute('aria-describedby') ?? '')
    expect(reason?.textContent).toBe('The release build passed there.')
    expect(radios[0]!.hasAttribute('aria-describedby')).toBe(false)

    // The person still chooses: the recommendation is not an answer.
    const submit = [...document.querySelectorAll('button')].find((button) => button.textContent === 'Submit Answer')
    expect(submit?.disabled).toBe(true)
    await dom.act(async () => radios[0]!.click())
    await dom.act(async () => submit!.click())
    expect(onSubmit).toHaveBeenCalledWith('staging')
  } finally {
    await dom.cleanup()
  }
})

test('only the first recommended option is marked, and a recommendation needs no reason', async () => {
  const dom = await renderQuestion({
    questions: [
      {
        id: 'checks',
        type: 'multi-select',
        question: 'Which checks should I run?',
        options: [
          { value: 'unit', recommended: true },
          { value: 'e2e', recommended: true, reason: 'Stored before the one-recommendation rule.' },
        ],
      },
    ],
  })
  try {
    const document = dom.window.document
    const labels = [...document.querySelectorAll('label')].filter((label) => label.querySelector('input'))
    expect(labels.map((label) => label.textContent)).toEqual(['unitRecommended', 'e2e', 'Other'])
    expect(document.body.textContent).not.toContain('Stored before')
    expect([...document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].some((box) => box.checked)).toBe(
      false
    )
  } finally {
    await dom.cleanup()
  }
})

test('a text suggestion can be recommended and still only fills the answer when chosen', async () => {
  const dom = await renderQuestion({
    questions: [
      {
        id: 'branch',
        type: 'text',
        question: 'Which branch should I deploy?',
        options: [{ value: 'main' }, { value: 'release/1.4', recommended: true, reason: 'It has the hotfix.' }],
      },
    ],
  })
  try {
    const document = dom.window.document
    const chips = [...(document.querySelector('[aria-label="Suggested answers"]')?.querySelectorAll('button') ?? [])]
    expect(chips.map((chip) => chip.textContent)).toEqual(['main', 'release/1.4 Recommended'])
    expect(document.getElementById(chips[1]!.getAttribute('aria-describedby') ?? '')?.textContent).toBe(
      'It has the hotfix.'
    )
    expect(document.querySelector('textarea')?.value).toBe('')
  } finally {
    await dom.cleanup()
  }
})

test('options without a recommendation render as before', async () => {
  const dom = await renderQuestion({
    questions: [{ id: 'env', type: 'select', question: 'Where?', options: [{ value: 'staging' }, { value: 'prod' }] }],
  })
  try {
    expect(dom.window.document.body.textContent).not.toContain('Recommended')
  } finally {
    await dom.cleanup()
  }
})
