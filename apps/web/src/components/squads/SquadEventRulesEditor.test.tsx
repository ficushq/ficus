import { fireEvent } from '@testing-library/dom'
import { expect, test, spyOn } from 'bun:test'
import { useState } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { squadEventRuleSchema, createBlankWorkflow, type SquadEventRule } from '@ficus/shared'
import { acquireDomHarness } from '../../test/domHarness'
import { integrationQueries, queries } from '../../queryOptions'
import { SquadEventRulesEditor } from './SquadEventRulesEditor'

test('event rules expose four actions, persist workflow selection, and allow priority and removal edits', async () => {
  const dom = await acquireDomHarness({ url: 'http://localhost/squads/test/settings' })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(integrationQueries.outputs().queryKey, [
    { integration: 'github', output: 'issue.assigned', version: 1, title: 'Issue assigned', fields: {} },
  ])
  client.setQueryData(integrationQueries.squad('test', 'github').queryKey, { connections: [], attached: [] })
  client.setQueryData(queries.workflows.list().queryKey, [{ id: 'reviewed-coding', definition: createBlankWorkflow() }])
  let value: SquadEventRule[] = []
  function Editor() {
    const [rules, setRules] = useState([
      squadEventRuleSchema.parse({
        id: 'first',
        source: { integration: 'github', output: 'issue.assigned', version: 1 },
        filters: {},
        action: { type: 'notify-manager' },
      }),
    ])
    value = rules
    return <SquadEventRulesEditor squadId="test" provider="github" value={rules} onChange={setRules} disabled={false} />
  }
  const root = dom.createRoot()
  const select = (label: string) =>
    Array.from(document.querySelectorAll('label'))
      .find((element) => element.firstChild?.textContent === label)!
      .querySelector('select')!
  const change = async (element: HTMLSelectElement, next: string) =>
    dom.act(async () => {
      element.value = next
      element.dispatchEvent(new Event('change', { bubbles: true }))
    })
  const click = async (text: string) =>
    dom.act(async () => {
      Array.from(document.querySelectorAll('button'))
        .find((button) => button.textContent === text)!
        .click()
    })
  try {
    await dom.act(async () =>
      root.root.render(
        <QueryClientProvider client={client}>
          <Editor />
        </QueryClientProvider>
      )
    )
    expect(Array.from(select('Then').options).map((option) => option.textContent)).toEqual([
      'Notify manager (unlinked events)',
      'Notify new consultant',
      'Create work stream',
      'Ignore',
    ])
    await dom.act(async () =>
      fireEvent.input(document.querySelector('textarea')!, {
        target: { value: 'Prepare an engineering stream and its worktree.' },
      })
    )
    expect(value[0]!.action).toMatchObject({
      type: 'notify-manager',
      additionalContext: 'Prepare an engineering stream and its worktree.',
    })
    await change(select('Then'), 'notify-consultant')
    await dom.act(async () =>
      fireEvent.input(document.querySelector('textarea')!, {
        target: { value: 'Research the issue before creating work.' },
      })
    )
    expect(value[0]!.action).toMatchObject({
      type: 'notify-consultant',
      additionalContext: 'Research the issue before creating work.',
    })

    expect(document.body.textContent).toContain('fresh consultant chat')
    await change(select('Then'), 'start-workstream')
    await change(select('Workflow'), 'reviewed-coding')
    expect(value[0]!.action).toEqual({
      type: 'start-workstream',
      workflow: { kind: 'preset', id: 'reviewed-coding', customizations: [] },
    })
    await change(select('Workflow'), '')
    expect(value[0]!.action).toEqual({ type: 'start-workstream', workflow: undefined })
    await dom.act(async () =>
      fireEvent.input(document.querySelector('textarea')!, {
        target: { value: 'Run the accessibility checks before requesting review.' },
      })
    )
    expect(value[0]!.action).toMatchObject({
      additionalContext: 'Run the accessibility checks before requesting review.',
    })
    await change(select('Workflow'), 'reviewed-coding')
    expect(value[0]!.action).toMatchObject({
      additionalContext: 'Run the accessibility checks before requesting review.',
    })
    expect(document.body.textContent).toContain('shared scope above is ignored')
    await change(select('Account involvement'), 'any')
    expect(document.body.textContent).toContain(
      'Comments and reviews authored by the selected account are always ignored'
    )
    await change(select('Account involvement'), 'assigned-or-mentioned')
    expect(document.body.textContent).toContain('Ignore events authored by that account or a bot')
    await click('Add event rule')
    expect(value).toHaveLength(2)
    expect(value[1]!.id).toBe('first')
    await click('Down')
    expect(value[0]!.id).toBe('first')
    await change(select('Then'), 'ignore')
    expect(value[0]!.action.type).toBe('ignore')
    await click('Remove')
    await click('Remove')
    expect(value).toEqual([])
    expect(document.body.textContent).toContain('No squad actions')
  } finally {
    client.clear()
    await dom.cleanup()
  }
})

test('typed conditions and synthetic preview follow unsaved filters and priority without network side effects', async () => {
  const { githubOutputCatalog } = await import('@ficus/shared')
  const dom = await acquireDomHarness({ url: 'http://localhost/squads/test/settings' })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(integrationQueries.outputs().queryKey, githubOutputCatalog)
  client.setQueryData(integrationQueries.squad('test', 'github').queryKey, { connections: [], attached: [] })
  const fetch = spyOn(globalThis, 'fetch')
  let value: SquadEventRule[] = []
  function Editor() {
    const [rules, setRules] = useState(
      ['first', 'fallback'].map((id) =>
        squadEventRuleSchema.parse({
          id,
          source: { integration: 'github', output: 'issue.assigned', version: 1 },
          filters: { audience: 'any', squadRouting: id === 'first' },
          action: { type: id === 'first' ? 'ignore' : 'notify-manager' },
        })
      )
    )
    value = rules
    return (
      <SquadEventRulesEditor
        squadId="test"
        provider="github"
        value={rules}
        onChange={setRules}
        disabled={false}
        metadata={{ github: [{ repo: 'acme/repo' }] }}
      />
    )
  }
  const root = dom.createRoot()
  const button = (text: string) =>
    Array.from(document.querySelectorAll('button')).find((button) => button.textContent === text)!
  const input = (label: string) => document.querySelector(`[aria-label="${label}"]`)!
  const change = (label: string, value: string) =>
    dom.act(async () => {
      fireEvent.change(input(label), { target: { value } })
    })
  try {
    await dom.act(async () =>
      root.root.render(
        <QueryClientProvider client={client}>
          <Editor />
        </QueryClientProvider>
      )
    )
    expect(button('Add condition')).toBeDefined()
    await dom.act(async () => button('Add condition').click())
    await change('Rule 1 condition 1 field', 'issue.number')
    await change('Rule 1 condition 1 operator', 'gte')
    await dom.act(async () => fireEvent.input(input('Rule 1 condition 1 value'), { target: { value: '5' } }))
    expect(value[0]?.predicates).toEqual([{ field: 'issue.number', op: 'gte', value: 5 }])
    await dom.act(async () =>
      fireEvent.input(input('Sample fields (JSON)'), {
        target: { value: '{"repository":"acme/repo","issue.number":5}' },
      })
    )
    expect(document.body.textContent).toContain('Selected: first → ignore')
    expect(document.body.textContent).toContain('fallback: shadowed')
    await dom.act(async () =>
      fireEvent.input(input('Sample fields (JSON)'), {
        target: { value: '{"repository":"acme/other","issue.number":5}' },
      })
    )
    expect(document.body.textContent).toContain('Selected: fallback → notify-manager')
    expect(document.body.textContent).toContain('Fail: Shared repository')
    await dom.act(async () =>
      fireEvent.input(input('Sample fields (JSON)'), { target: { value: '{"body":"do not expose payloads"}' } })
    )
    expect(document.body.textContent).toContain('Unsupported sample field')
    expect(document.body.textContent).not.toContain('Selected:')
    await dom.act(async () =>
      fireEvent.input(input('Sample fields (JSON)'), {
        target: { value: '{"repository":"acme/repo","issue.number":5}' },
      })
    )
    await dom.act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Move rule 1 down"]')!.click())
    expect(document.body.textContent).toContain('Selected: fallback → notify-manager')
    expect(document.body.textContent).toContain('first: shadowed')
    expect(document.body.textContent).toContain('not a delivery guarantee')
    await change('Rule 2 condition 1 operator', 'in')
    await dom.act(async () =>
      fireEvent.input(input('Rule 2 condition 1 value'), { target: { value: '["wrong-type"]' } })
    )
    expect(document.body.textContent).toContain('Predicate requires an array of number operands')
    expect(document.body.textContent).not.toContain('Selected:')
    // Changing event clears incompatible predicates rather than persisting hidden conditions.
    await dom.act(async () =>
      fireEvent.change(document.querySelectorAll('fieldset')[1]!.querySelector('select')!, {
        target: { value: 'pull_request.reviewed' },
      })
    )
    expect(value[1]?.predicates).toBeUndefined()
    await change('Sample event', 'pull_request.reviewed@1')
    expect((input('Sample fields (JSON)') as HTMLTextAreaElement).value).toBe('{}')
    expect(fetch).not.toHaveBeenCalled()
    // Read-only settings retain the preview but keep all rule editing disabled.
    await dom.act(async () =>
      root.root.render(
        <QueryClientProvider client={client}>
          <SquadEventRulesEditor
            squadId="test"
            provider="github"
            value={value}
            onChange={() => {
              throw new Error('Read-only editor changed rules')
            }}
            disabled={true}
          />
        </QueryClientProvider>
      )
    )
    expect(Array.from(document.querySelectorAll('fieldset')).every((fieldset) => fieldset.disabled)).toBe(true)
    expect(button('Add event rule').disabled).toBe(true)
    expect(document.querySelector('[aria-label="Match preview"]')).not.toBeNull()
  } finally {
    fetch.mockRestore()
    client.clear()
    await dom.cleanup()
  }
})

test('Dependabot defaults render manager routing and editable severity, state and action predicates', async () => {
  const { effectiveSquadEventRules, githubOutputCatalog } = await import('@ficus/shared')
  const dom = await acquireDomHarness({ url: 'http://localhost/squads/test/settings' })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(integrationQueries.outputs().queryKey, githubOutputCatalog)
  client.setQueryData(integrationQueries.squad('test', 'github').queryKey, { connections: [], attached: [] })
  const rules = effectiveSquadEventRules({}, 'github').filter(
    (rule) => rule.source.output === 'dependabot_alert.updated'
  )
  const root = dom.createRoot()
  try {
    await dom.act(async () =>
      root.root.render(
        <QueryClientProvider client={client}>
          <SquadEventRulesEditor squadId="test" provider="github" value={rules} onChange={() => {}} disabled={false} />
        </QueryClientProvider>
      )
    )
    const selected = Array.from(document.querySelectorAll('select')).map((select) => select.value)
    expect(selected).toContain('dependabot_alert.updated')
    expect(selected).toContain('notify-manager')
    for (const field of ['severity', 'state', 'action']) expect(selected).toContain(field)
    expect(document.body.textContent).toContain('Repository')
    expect(document.querySelector('input[type="checkbox"]')?.checked).toBe(true)
  } finally {
    await dom.cleanup()
    client.clear()
  }
})

test('decision conditions edit a yes/no or choice question, its matching answer and no-answer behavior', async () => {
  const { githubOutputCatalog } = await import('@ficus/shared')
  const dom = await acquireDomHarness({ url: 'http://localhost/squads/test/settings' })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(integrationQueries.outputs().queryKey, githubOutputCatalog)
  client.setQueryData(integrationQueries.squad('test', 'github').queryKey, { connections: [], attached: [] })
  client.setQueryData(queries.workflows.list().queryKey, [])
  const fetch = spyOn(globalThis, 'fetch')
  let value: SquadEventRule[] = []
  function Editor() {
    const [rules, setRules] = useState(
      ['urgent', 'fallback'].map((id) =>
        squadEventRuleSchema.parse({
          id,
          source: { integration: 'github', output: 'issue.comment', version: 1 },
          filters: { audience: 'any' },
          action: { type: id === 'urgent' ? 'start-workstream' : 'notify-manager' },
        })
      )
    )
    value = rules
    return <SquadEventRulesEditor squadId="test" provider="github" value={rules} onChange={setRules} disabled={false} />
  }
  const root = dom.createRoot()
  const button = (text: string) =>
    Array.from(document.querySelectorAll('button')).find((button) => button.textContent === text)!
  const labelled = <T extends Element = HTMLElement>(label: string) =>
    document.querySelector<T & Element>(`[aria-label="${label}"]`)!
  const type = (label: string, text: string) =>
    dom.act(async () => {
      fireEvent.input(labelled(label), { target: { value: text } })
    })
  const segment = (group: string, text: string) =>
    dom.act(async () =>
      Array.from(labelled(group).querySelectorAll('button'))
        .find((button) => button.textContent === text)!
        .click()
    )
  const errors = () => document.querySelector('[role="alert"]')?.textContent ?? ''
  try {
    await dom.act(async () =>
      root.root.render(
        <QueryClientProvider client={client}>
          <Editor />
        </QueryClientProvider>
      )
    )
    await dom.act(async () =>
      Array.from(document.querySelectorAll('button'))
        .find((b) => b.textContent === 'Add decision condition')!
        .click()
    )
    const prefix = 'Rule 1 condition 1'
    expect(value[0]!.predicates).toEqual([
      {
        kind: 'decision',
        question: { type: 'yesno', instructions: '' },
        when: { type: 'yesno', op: 'at-least', probability: 0.5 },
        onUnavailable: 'no-match',
      },
    ])
    // An empty question cannot be saved.
    expect(errors()).not.toBe('')
    await type(`${prefix} question`, 'The comment reports something urgent.')
    await type(`${prefix} threshold`, '')
    expect(errors()).not.toBe('')
    await type(`${prefix} threshold`, '0.2')
    await segment(`${prefix} comparison`, 'At most')
    await segment(`${prefix} when no decision model answers`, 'Match')
    expect(value[0]!.predicates).toEqual([
      {
        kind: 'decision',
        question: { type: 'yesno', instructions: 'The comment reports something urgent.' },
        when: { type: 'yesno', op: 'at-most', probability: 0.2 },
        onUnavailable: 'match',
      },
    ])
    expect(squadEventRuleSchema.safeParse(value[0]).success).toBe(true)
    expect(errors()).toBe('')
    expect(document.body.textContent).toContain(
      'Sends the event’s subject, issue.title, actor, actorType, labels and text'
    )

    // The preview asks no model; it states and applies an assumption.
    await dom.act(async () => {
      fireEvent.change(labelled('Sample event'), { target: { value: 'issue.comment@1' } })
    })
    expect(document.body.textContent).toContain('Selected: urgent → start-workstream')
    expect(document.body.textContent).toContain('assumed to match in this preview')
    await segment('Assume decision conditions', 'Don’t match')
    expect(document.body.textContent).toContain('Selected: fallback → notify-manager')

    // A choice question: options, the expected option, and a confidence floor.
    await segment(`${prefix} question type`, 'Choice')
    expect(value[0]!.predicates![0]).toMatchObject({
      question: { type: 'choice', options: { option_1: '', option_2: '' } },
      when: { type: 'choice', equals: 'option_1' },
    })
    await type(`${prefix} option 1 name`, 'bug')
    await type(`${prefix} option 1 description`, 'Something is broken')
    await type(`${prefix} option 2 name`, 'feature')
    // Renaming to a name already taken is refused rather than merging two options.
    await type(`${prefix} option 2 name`, 'bug')
    await dom.act(async () => button('Add option').click())
    await type(`${prefix} option 3 name`, 'question')
    await dom.act(async () => labelled<HTMLButtonElement>(`${prefix} expected choice`).click())
    await dom.act(async () => {
      await new Promise((resolve) => dom.window.requestAnimationFrame(resolve))
    })
    await dom.act(async () =>
      Array.from(document.querySelectorAll<HTMLElement>('[role="option"]'))
        .find((option) => option.textContent?.startsWith('feature'))!
        .click()
    )
    await type(`${prefix} minimum confidence`, '0.6')
    expect(value[0]!.predicates![0]).toEqual({
      kind: 'decision',
      question: {
        type: 'choice',
        instructions: 'The comment reports something urgent.',
        options: { bug: 'Something is broken', feature: '', question: '' },
      },
      when: { type: 'choice', equals: 'feature', minConfidence: 0.6 },
      onUnavailable: 'match',
    })
    expect(squadEventRuleSchema.safeParse(value[0]).success).toBe(true)
    // Removing the expected option moves the match to a remaining one.
    await dom.act(async () => labelled<HTMLButtonElement>(`Remove ${prefix.toLowerCase()} option 2`).click())
    expect(value[0]!.predicates![0]).toMatchObject({ when: { type: 'choice', equals: 'bug' } })
    await type(`${prefix} option 1 name`, 'Bug Report')
    expect(errors()).toContain('Use lowercase letters, digits and underscores.')
    await dom.act(async () => labelled<HTMLButtonElement>(`Remove ${prefix.toLowerCase()}`).click())
    expect(value[0]!.predicates).toEqual([])
    expect(fetch).not.toHaveBeenCalled()
  } finally {
    fetch.mockRestore()
    client.clear()
    await dom.cleanup()
  }
})
