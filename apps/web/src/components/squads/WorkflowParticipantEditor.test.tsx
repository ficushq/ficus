import { test, expect } from 'bun:test'
import { useState } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createBlankWorkflow } from '@ficus/shared'
import { queries } from '../../queryOptions'
import { acquireDomHarness } from '../../test/domHarness'
import { WorkflowParticipantEditor } from './WorkflowParticipantEditor'

test('shared participant edits retain step instructions and rename every reference', async () => {
  const dom = await acquireDomHarness({ url: 'http://localhost/settings/workflows' })
  const { root } = dom.createRoot()
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(queries.modelTiers.list().queryKey, [])
  client.setQueryData(queries.agentTypes.list().queryKey, [{ id: 'general', name: 'General Purpose' }])
  let definition = createBlankWorkflow()
  definition.steps.push({ ...structuredClone(definition.steps[0]!), id: 'publish', instructions: 'Publish the result' })
  function Harness() {
    const [value, setValue] = useState(definition)
    const [selected, setSelected] = useState('worker')
    definition = value
    return (
      <WorkflowParticipantEditor definition={value} onChange={setValue} selected={selected} onSelect={setSelected} />
    )
  }
  const click = async (text: string) =>
    dom.act(async () => {
      const button = [...document.querySelectorAll('button')].find((item) => item.textContent === text)!
      button.click()
    })
  const input = (label: string) =>
    [...document.querySelectorAll('label')]
      .find((item) => item.textContent?.startsWith(label))!
      .querySelector<HTMLInputElement>('input')!
  try {
    await dom.act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <Harness />
        </QueryClientProvider>
      )
    )
    expect(document.querySelector('[aria-label="Participant usage"]')?.textContent).toContain('execute, publish')
    expect(
      [...document.querySelectorAll('button')].find((item) => item.textContent === 'Remove participant')!.disabled
    ).toBe(true)
    const session = [...document.querySelectorAll('label')]
      .find((item) => item.textContent?.startsWith('Session'))!
      .querySelector('select')!
    await dom.act(async () => {
      session.value = 'fresh-per-attempt'
      session.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
    })
    expect(definition.participants.worker!.session).toBe('fresh-per-attempt')
    expect(definition.steps[1]!.instructions).toBe('Publish the result')
    await dom.act(async () => {
      const field = input('Participant ID')
      field.value = 'engineer'
      field.dispatchEvent(new dom.window.FocusEvent('focusout', { bubbles: true }))
    })
    expect(definition.participants.worker).toBeUndefined()
    expect(definition.steps.every((step) => step.kind === 'agent' && step.participant === 'engineer')).toBe(true)
    await dom.act(async () => {
      const field = input('New participant ID')
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(field, 'reviewer')
      field.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
    })
    await click('Add participant')
    expect(definition.participants.reviewer?.agentTypeId).toBe('general')
    expect(definition.steps.every((step) => step.kind === 'agent' && step.participant === 'engineer')).toBe(true)
    await click('Remove participant')
    expect(definition.participants.reviewer).toBeUndefined()
    expect(definition.participants.engineer?.session).toBe('fresh-per-attempt')
    expect(document.querySelector('[aria-label="Choose participant"]')?.textContent).toContain('Used by 2 steps')
    await dom.act(async () =>
      document.querySelector<HTMLButtonElement>('[aria-label="Make publish separate"]')!.click()
    )
    expect(definition.steps[1]!.kind === 'agent' && definition.steps[1]!.participant).toBe('publish-agent')
    expect(definition.steps[0]!.kind === 'agent' && definition.steps[0]!.participant).toBe('engineer')
    expect(definition.participants['publish-agent']).toEqual(definition.participants.engineer!)
    expect(input('Participant ID').value).toBe('publish-agent')
    expect(document.querySelector('[aria-label="Choose participant"]')?.textContent).toContain('Used by 1 step')
  } finally {
    client.clear()
    await dom.cleanup()
  }
})

test('tier dropdown overrides the engineer tier and can return to agent type defaults', async () => {
  const dom = await acquireDomHarness({ url: 'http://localhost/settings/workflows' })
  const { root } = dom.createRoot()
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(queries.agentTypes.list().queryKey, [{ id: 'engineer', name: 'Engineer' }])
  client.setQueryData(queries.modelTiers.list().queryKey, [
    { slug: 'deep', label: 'Deep' },
    { slug: 'exhaustive', label: 'Exhaustive' },
    { slug: 'disabled', label: 'Disabled', disabled: true },
  ])
  let definition = createBlankWorkflow()
  definition.participants.worker = { agentTypeId: 'engineer', session: 'reuse-within-stream' }
  function Harness() {
    const [value, setValue] = useState(definition)
    definition = value
    return <WorkflowParticipantEditor definition={value} onChange={setValue} selected="worker" onSelect={() => {}} />
  }
  const selector = () =>
    [...document.querySelectorAll('label')]
      .find((label) => label.textContent?.startsWith('Model tier'))!
      .querySelector('select')!
  try {
    await dom.act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <Harness />
        </QueryClientProvider>
      )
    )
    expect(selector().value).toBe('')
    expect([...selector().options].map((o) => o.value)).not.toContain('disabled')
    for (const tier of ['deep', 'exhaustive', '']) {
      await dom.act(async () => {
        selector().value = tier
        selector().dispatchEvent(new dom.window.Event('change', { bubbles: true }))
      })
      expect(definition.participants.worker).toEqual({
        agentTypeId: 'engineer',
        session: 'reuse-within-stream',
        ...(tier ? { tier } : {}),
      })
    }
  } finally {
    client.clear()
    await dom.cleanup()
  }
})
