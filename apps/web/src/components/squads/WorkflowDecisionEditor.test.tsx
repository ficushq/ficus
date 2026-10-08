import { expect, test } from 'bun:test'
import { useState } from 'react'
import { workflowDecisionStepIssues, workflowStepSchema, type WorkflowDecisionStep } from '@ficus/shared'
import { acquireDomHarness } from '../../test/domHarness'
import { WorkflowDecisionEditor } from './WorkflowDecisionEditor'

const initial = workflowStepSchema.parse({
  id: 'triage',
  kind: 'decision',
  instructions: 'Decide whether the change can ship.',
  questions: { ready: { type: 'yesno', instructions: 'The change is complete and verified.' } },
  routes: [{ when: { type: 'yesno', question: 'ready', op: 'at-least', probability: 0.8 }, outcome: 'ship' }],
  outcomes: { ship: { next: 'finish' }, review: { next: 'finish' } },
}) as WorkflowDecisionStep

test('the decision editor edits inputs, questions, routes and fallbacks', async () => {
  const dom = await acquireDomHarness({ url: 'http://localhost/settings/workflows' })
  let value = initial
  function Editor() {
    const [step, setStep] = useState(initial)
    value = step
    return <WorkflowDecisionEditor step={step} onChange={setStep} />
  }
  const root = dom.createRoot()
  const query = <T extends Element = HTMLElement>(selector: string) => document.querySelector<T>(selector)!
  const button = (text: string) =>
    Array.from(document.querySelectorAll('button')).find((el) => el.textContent?.trim() === text)!
  const click = async (element: Element) => dom.act(async () => (element as HTMLElement).click())
  const type = async (element: HTMLInputElement | HTMLTextAreaElement, text: string) =>
    dom.act(async () => {
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value')!.set!
      setter.call(element, text)
      element.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
    })
  /** Open a SelectionPopup by its label and choose an option by its text. */
  const pick = async (label: string, option: string) => {
    const trigger = query(`[role="combobox"][aria-label="${label}"]`)
    await click(trigger)
    await dom.act(async () => {
      await new Promise((resolve) => dom.window.requestAnimationFrame(resolve))
    })
    const listbox = document.getElementById(trigger.getAttribute('aria-controls')!)!
    const choice = Array.from(listbox.querySelectorAll('[role="option"]')).find((el) =>
      el.textContent?.startsWith(option)
    )!
    expect(choice).toBeDefined()
    await click(choice)
  }
  try {
    await dom.act(async () => root.root.render(<Editor />))
    expect(document.body.textContent).toContain('No agent works on this step')

    // Inputs: the last one cannot be cleared.
    const inputs = () =>
      Array.from(document.querySelectorAll<HTMLInputElement>('fieldset input[type="checkbox"]')).map((el) => [
        el.checked,
        el.disabled,
      ])
    expect(inputs()).toEqual([
      [true, false],
      [true, false],
      [false, false],
      [true, false],
    ])
    await click(document.querySelectorAll('fieldset input[type="checkbox"]')[2]!)
    expect(value.input).toEqual(['title', 'description', 'handoff', 'incoming-results'])

    // A yes/no route edits its threshold as a percentage.
    const threshold = query<HTMLInputElement>('[aria-label="Route 1 probability percent"]')
    expect(threshold.value).toBe('80')
    await type(threshold, '65')
    expect(value.routes[0]!.when).toEqual({ type: 'yesno', question: 'ready', op: 'at-least', probability: 0.65 })
    await pick('Route 1 comparison', 'at most')
    expect(value.routes[0]!.when).toMatchObject({ op: 'at-most' })

    // A second question as a choice, and a route on one of its options.
    await click(button('Add question'))
    expect(Object.keys(value.questions)).toEqual(['ready', 'question'])
    const [, secondType] = document.querySelectorAll('[aria-label$=" type"][role="radiogroup"]')
    await click(Array.from(secondType!.querySelectorAll('[role="radio"]')).find((el) => el.textContent === 'Choice')!)
    expect(value.questions.question).toEqual({ type: 'choice', instructions: '', options: { first: '', second: '' } })
    await type(query('[aria-label="Question question instructions"]'), 'What kind of change is this?')
    await click(button('Add route'))
    await pick('Route 2 question', 'question')
    expect(value.routes[1]).toEqual({
      when: { type: 'choice', question: 'question', equals: 'first' },
      outcome: 'ship',
    })
    await pick('Route 2 option', 'second')
    await type(query('[aria-label="Route 2 minimum confidence percent"]'), '70')
    await pick('Route 2 outcome', 'review')
    expect(value.routes[1]).toEqual({
      when: { type: 'choice', question: 'question', equals: 'second', minConfidence: 0.7 },
      outcome: 'review',
    })

    // Renaming an option keeps routes on it.
    const option = query<HTMLInputElement>('[aria-label="Option second name"]')
    await dom.act(async () => {
      option.value = 'feature'
      option.dispatchEvent(new dom.window.FocusEvent('focusout', { bubbles: true }))
    })
    expect(value.routes[1]!.when).toMatchObject({ equals: 'feature' })

    // Routes reorder; the first match wins.
    await click(query('[aria-label="Move route 2 up"]'))
    expect(value.routes.map((route) => route.outcome)).toEqual(['review', 'ship'])

    // Fallbacks default to asking a person and can follow an outcome.
    expect(query('[role="combobox"][aria-label="Otherwise"]').textContent).toContain('Ask a person')
    await pick('Otherwise', 'review')
    await pick('If there is no answer', 'ship')
    expect([value.otherwise, value.unavailable]).toEqual(['review', 'ship'])
    await pick('If there is no answer', 'Ask a person')
    expect(value.unavailable).toBeUndefined()
    expect(workflowDecisionStepIssues(value)).toEqual([])

    // Removing a question removes its routes.
    const removes = Array.from(document.querySelectorAll('button')).filter((el) => el.textContent === 'Remove')
    await click(removes[1]!)
    expect(Object.keys(value.questions)).toEqual(['ready'])
    expect(value.routes.map((route) => route.when.question)).toEqual(['ready'])
    expect(document.querySelector('[role="alert"]')).toBeNull()
  } finally {
    await dom.cleanup()
  }
})

test('the decision editor shows routes that point at missing outcomes', async () => {
  const dom = await acquireDomHarness({ url: 'http://localhost/settings/workflows' })
  const root = dom.createRoot()
  try {
    const broken = { ...initial, routes: [{ ...initial.routes[0]!, outcome: 'launch' }], otherwise: 'later' }
    await dom.act(async () => root.root.render(<WorkflowDecisionEditor step={broken} onChange={() => {}} />))
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "Route 1 uses unknown outcome 'launch'; add it to the step's outcomes"
    )
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("Otherwise uses unknown outcome 'later'")
  } finally {
    await dom.cleanup()
  }
})
