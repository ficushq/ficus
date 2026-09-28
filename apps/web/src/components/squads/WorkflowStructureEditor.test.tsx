import { expect, test } from 'bun:test'
import { useState } from 'react'
import { createBlankWorkflow, workflowDefinitionSchema } from '@ficus/shared'
import { acquireDomHarness } from '../../test/domHarness'
import { WorkflowStructureEditor } from './WorkflowStructureEditor'

test('structure editor adds participants and steps, preserving a valid sequential route', async () => {
  const dom = await acquireDomHarness({ url: 'http://localhost/edit-flow' })
  let definition = createBlankWorkflow()
  function Editor() {
    const [value, setValue] = useState(definition)
    return (
      <WorkflowStructureEditor
        definition={value}
        onChange={(next) => {
          definition = next
          setValue(next)
        }}
      />
    )
  }
  const root = dom.createRoot()
  const type = async (placeholder: string, value: string) =>
    dom.act(async () => {
      const input = dom.window.document.querySelector(`input[placeholder="${placeholder}"]`)!
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(input, value)
      input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
    })
  const click = async (label: string) =>
    dom.act(async () =>
      [...dom.window.document.querySelectorAll('button')].find((b) => b.textContent === label)!.click()
    )
  try {
    await dom.act(async () => root.root.render(<Editor />))
    await type('security-reviewer', 'editor')
    await click('Add participant')
    expect(definition.participants.editor!.agentTypeId).toBe('general')
    await type('security-review', 'edit')
    await click('Add step')
    expect(definition.steps[0]!.outcomes.completed).toEqual({ next: 'edit' })
    expect(definition.steps[1]!.id).toBe('edit')
    expect(workflowDefinitionSchema.safeParse(definition).success).toBe(true)
  } finally {
    await dom.cleanup()
  }
})

test('the delegation limit enables specialist help, zero disables it, and guided routing resets it', async () => {
  const dom = await acquireDomHarness({ url: 'http://localhost/edit-flow' })
  let definition = createBlankWorkflow()
  definition.routing.mode = 'flexible'
  function Editor() {
    const [value, setValue] = useState(definition)
    return (
      <WorkflowStructureEditor
        mode="settings"
        definition={value}
        onChange={(next) => {
          definition = next
          setValue(next)
        }}
      />
    )
  }
  const { root } = dom.createRoot()
  const control = (label: string) =>
    [...document.querySelectorAll('label')]
      .find((node) => node.textContent?.trim().startsWith(label))!
      .querySelector('input,select') as HTMLInputElement | HTMLSelectElement
  const limit = async (value: string) =>
    dom.act(async () => {
      const input = control('Delegation limit')
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(input, value)
      input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
    })
  try {
    await dom.act(async () => root.render(<Editor />))
    expect(document.body.textContent).not.toContain('Allow tracked specialist delegation')
    await limit('3')
    expect(definition.routing.delegation).toBe('allowed')
    expect(definition.limits.maxDelegations).toBe(3)
    expect(workflowDefinitionSchema.safeParse(definition).success).toBe(true)
    await limit('0')
    expect(definition.routing.delegation).toBe('disabled')
    expect(definition.limits.maxDelegations).toBe(0)
    await limit('2')
    await dom.act(async () => {
      const select = control('Routing')
      select.value = 'guided'
      select.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
    })
    expect(definition.routing.delegation).toBe('disabled')
    expect(definition.limits.maxDelegations).toBe(0)
    expect(control('Delegation limit').disabled).toBe(true)
    expect(workflowDefinitionSchema.safeParse(definition).success).toBe(true)
  } finally {
    await dom.cleanup()
  }
})

test.each([
  ['maxStepAttempts', 'No attempt limit'],
  ['maxParallelAttempts', 'No workflow limit'],
] as const)('%s is unset by default and an optional override can be cleared', async (key, placeholder) => {
  const dom = await acquireDomHarness({ url: 'http://localhost/edit-flow' })
  let definition = createBlankWorkflow()
  function Editor() {
    const [value, setValue] = useState(definition)
    return (
      <WorkflowStructureEditor
        mode="settings"
        definition={value}
        onChange={(next) => {
          definition = next
          setValue(next)
        }}
      />
    )
  }
  const { root } = dom.createRoot()
  try {
    await dom.act(async () => root.render(<Editor />))
    const input = document.querySelector(`input[placeholder="${placeholder}"]`) as HTMLInputElement
    expect(input.value).toBe('')
    expect(input.closest('details')!.open).toBe(false)
    for (const value of ['2', '']) {
      await dom.act(async () => {
        Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(input, value)
        input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
      })
      expect(definition.limits[key]).toBe(value ? 2 : undefined)
      expect(workflowDefinitionSchema.safeParse(definition).success).toBe(true)
    }
    expect(Object.hasOwn(definition.limits, key)).toBe(false)
  } finally {
    await dom.cleanup()
  }
})

test('a rework handoff changes its return behavior without changing its destination', async () => {
  const dom = await acquireDomHarness({ url: 'http://localhost/edit-flow' })
  let definition = createBlankWorkflow()
  definition.steps[0]!.outcomes.completed = { next: 'review' }
  definition.steps.push({
    ...structuredClone(definition.steps[0]!),
    id: 'review',
    outcomes: { approved: { next: 'finish' }, revise: { returnTo: 'execute' } },
  })
  function Editor() {
    const [value, setValue] = useState(definition)
    return (
      <WorkflowStructureEditor
        definition={value}
        mode="step"
        selectedStep="review"
        onlyOutcome="revise"
        onChange={(next) => {
          definition = next
          setValue(next)
        }}
      />
    )
  }
  try {
    const root = dom.createRoot()
    await dom.act(async () => root.root.render(<Editor />))
    const select = document.querySelector<HTMLSelectElement>('[aria-label="After rework"]')!
    expect(select.value).toBe('follow-graph')
    expect(
      [...document.querySelectorAll('option')].some((option) => option.textContent === 'Run parallel branches')
    ).toBe(false)
    for (const mode of ['return-to-requester', 'follow-graph']) {
      await dom.act(async () => {
        select.value = mode
        select.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
      })
      expect(definition.steps[1]!.outcomes.revise).toEqual({ returnTo: 'execute', afterRework: mode })
      expect(definition.steps[1]!.outcomes.approved).toEqual({ next: 'finish' })
    }
  } finally {
    await dom.cleanup()
  }
})

test('approval options explain assigned-reviewer fallback and keep explicit any-reviewer choices', async () => {
  const dom = await acquireDomHarness({ url: 'http://localhost/edit-flow' })
  const definition = createBlankWorkflow()
  definition.steps = [
    {
      id: 'review',
      kind: 'human-approval',
      approver: 'assigned-reviewers',
      instructions: 'Review',
      output: 'Decision',
      outcomes: { approved: { next: 'finish' } },
    },
  ]
  definition.entry = 'review'
  const { root } = dom.createRoot()
  try {
    await dom.act(async () => root.render(<WorkflowStructureEditor definition={definition} onChange={() => {}} />))
    const label = [...document.querySelectorAll('label')].find((node) =>
      node.textContent?.trim().startsWith('Approver')
    )!
    const select = label.querySelector('select')!
    expect([...select.options].map((option) => option.textContent)).toEqual(['Assigned reviewers', 'Any reviewer'])
    expect(select.value).toBe('assigned-reviewers')
    expect(label.textContent).toContain('If no reviewers are assigned,')
    expect(label.textContent).toContain('any reviewer is allowed')
    expect(label.textContent).not.toContain('Requesting user')
  } finally {
    await dom.cleanup()
  }
})
