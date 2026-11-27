import { afterEach, describe, expect, it } from 'bun:test'
import type { QuestionData } from '@ficus/shared'
import { QuestionCard } from './QuestionCard'
import { byText, click, makeFakeClient, render } from './testing'

const mounted: Array<() => void> = []
afterEach(() => {
  for (const unmount of mounted.splice(0)) unmount()
})

async function renderCard(questionData: QuestionData) {
  const submitted: string[] = []
  const view = await render(
    <QuestionCard questionData={questionData} onSubmit={(answer) => submitted.push(answer)} />,
    {
      client: makeFakeClient().client,
    }
  )
  mounted.push(view.unmount)
  return { ...view, submitted }
}

const optionFor = (root: ParentNode, value: string) => {
  const input = root.querySelector<HTMLInputElement>(`input[value="${value}"]`)
  if (!input) throw new Error(`No option ${value}`)
  return { input, label: input.closest('label')! }
}

const checkbox = (root: ParentNode, startsWith: string) => {
  const label = [...root.querySelectorAll('label.g-chat-option')].find((el) => el.textContent?.startsWith(startsWith))
  if (!label) throw new Error(`No checkbox ${startsWith}`)
  return { input: label.querySelector('input')!, label }
}

const chip = (root: ParentNode, startsWith: string) => {
  const found = [...root.querySelectorAll<HTMLButtonElement>('.g-chat-chip')].find((el) =>
    el.textContent?.startsWith(startsWith)
  )
  if (!found) throw new Error(`No chip ${startsWith}`)
  return found
}

const recommendedQuestions: QuestionData = {
  questions: [
    {
      id: 'crop',
      type: 'select',
      question: 'Which crop?',
      options: [{ value: 'kale' }, { value: 'corn', label: 'Corn', recommended: true, reason: 'It suits the soil.' }],
    },
    {
      id: 'days',
      type: 'multi-select',
      question: 'Days',
      // ask_human allows one; should stored data carry two, only the first is marked.
      options: [
        { value: 'mon', recommended: true },
        { value: 'tue', recommended: true, reason: 'Second flag' },
      ],
    },
    {
      id: 'when',
      type: 'text',
      question: 'Water when?',
      options: [
        { value: 'dawn', label: 'At dawn' },
        { value: 'dusk', recommended: true, reason: 'Less evaporation.' },
      ],
    },
  ],
}

describe('QuestionCard · recommended option', () => {
  it('tags the recommended option with its reason, without preselecting anything', async () => {
    const { container } = await renderCard(recommendedQuestions)

    const corn = optionFor(container, 'corn')
    expect(corn.label.querySelector('.g-recommended')?.textContent).toBe('Recommended')
    expect(corn.label.querySelector('.g-recommended-reason')?.textContent).toBe('It suits the soil.')
    expect(optionFor(container, 'kale').label.querySelector('.g-recommended')).toBeNull()

    // Only the first flagged option is marked, and an option with no reason shows just the tag.
    const mon = checkbox(container, 'mon')
    expect(mon.label.querySelector('.g-recommended')).not.toBeNull()
    expect(mon.label.querySelector('.g-recommended-reason')).toBeNull()
    expect(checkbox(container, 'tue').label.querySelector('.g-recommended')).toBeNull()
    expect(container.textContent).not.toContain('Second flag')

    // The text question's chip carries the tag; its reason sits below the chips and describes it.
    const dusk = chip(container, 'dusk')
    expect(dusk.querySelector('.g-recommended')?.textContent).toBe('Recommended')
    const reason = container.ownerDocument.getElementById(dusk.getAttribute('aria-describedby')!)
    expect(reason?.textContent).toBe('Less evaporation.')
    expect(chip(container, 'At dawn').querySelector('.g-recommended')).toBeNull()
    expect(chip(container, 'At dawn').hasAttribute('aria-describedby')).toBe(false)

    expect(container.querySelectorAll('.g-recommended')).toHaveLength(3)
    expect([...container.querySelectorAll('input')].some((input) => input.checked)).toBe(false)
    expect(dusk.getAttribute('aria-pressed')).toBe('false')
    expect(container.querySelector('textarea')!.value).toBe('')
    expect(byText<HTMLButtonElement>(container, 'button[type="submit"]', 'Submit answers').disabled).toBe(true)
  })

  it('submits exactly the chosen values, whichever option is recommended', async () => {
    const { container, submitted } = await renderCard(recommendedQuestions)

    await click(optionFor(container, 'kale').input)
    await click(checkbox(container, 'tue').input)
    await click(chip(container, 'dusk'))
    expect(container.querySelector('textarea')!.value).toBe('dusk')
    await click(byText(container, 'button[type="submit"]', 'Submit answers'))

    expect(submitted).toEqual([JSON.stringify({ crop: 'kale', days: 'tue', when: 'dusk' }, null, 2)])
  })

  it('renders questions without a recommendation as before', async () => {
    const { container, submitted } = await renderCard({
      questions: [
        { id: 'crop', type: 'select', question: 'Which crop?', options: [{ value: 'kale' }, { value: 'corn' }] },
        { id: 'when', type: 'text', question: 'Water when?', options: [{ value: 'dawn', label: 'At dawn' }] },
      ],
    })
    expect(container.querySelector('.g-recommended')).toBeNull()
    expect(container.querySelector('.g-recommended-reason')).toBeNull()
    expect(container.querySelector('.g-option-text')).toBeNull()
    expect(optionFor(container, 'corn').label.textContent).toBe('corn')
    expect(chip(container, 'At dawn').textContent).toBe('At dawn')
    expect(chip(container, 'At dawn').hasAttribute('aria-describedby')).toBe(false)

    await click(optionFor(container, 'corn').input)
    await click(chip(container, 'At dawn'))
    await click(byText(container, 'button[type="submit"]', 'Submit answers'))
    expect(submitted).toEqual([JSON.stringify({ crop: 'corn', when: 'dawn' }, null, 2)])
  })
})
