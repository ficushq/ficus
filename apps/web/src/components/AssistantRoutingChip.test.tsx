import { afterEach, expect, mock, test } from 'bun:test'
import type { AssistantRoutingHint } from '@ficus/shared'
import { acquireDomHarness } from '../test/domHarness'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { queryKeys } from '../queryKeys'
import {
  AssistantDraftRouting,
  AssistantMessageRouting,
  AssistantRoutingChip,
  assistantMoveRequest,
  latestAssistantUserMessageId,
  type AssistantRoutingPick,
} from './AssistantRoutingChip'

let dom: Awaited<ReturnType<typeof acquireDomHarness>> | undefined
afterEach(async () => {
  await dom?.cleanup()
  dom = undefined
})

const chlea = { id: 'a1b2c3d4-0000-4000-8000-000000000001', name: 'Chlea', purpose: 'The Chlea app' }
const billing = { id: 'b2c3d4e5-0000-4000-8000-000000000002', name: 'Billing', purpose: 'Invoices and refunds' }

async function render(hint: AssistantRoutingHint, onCorrect = mock(async (_pick: AssistantRoutingPick) => ({}))) {
  dom = await acquireDomHarness({ url: 'http://localhost' })
  const { root, container } = dom.createRoot()
  await dom.act(async () =>
    root.render(<AssistantRoutingChip hint={hint} squads={[chlea, billing]} onCorrect={onCorrect} />)
  )
  const trigger = () => container.querySelector<HTMLButtonElement>('button[role="combobox"]')!
  const open = async () => {
    await dom!.act(async () => trigger().click())
    await dom!.act(async () => {
      await new Promise((resolve) => dom!.window.requestAnimationFrame(resolve))
    })
  }
  const option = (label: string) =>
    [...dom!.window.document.querySelectorAll<HTMLElement>('[role="option"]')].find((row) =>
      row.textContent?.startsWith(label)
    )!
  return { container, trigger, open, option, onCorrect }
}

test('a squad pick reads as the squad, with a squad icon and no confidence', async () => {
  const { trigger } = await render({ scope: 'squad', squadId: chlea.id, squadName: 'Chlea', confidence: 0.914 })
  expect(trigger().textContent).toBe('Chlea')
  expect(trigger().getAttribute('aria-label')).toBe('Routing: Chlea. Change squad')
  expect(trigger().className).toContain('ficus-button-secondary')
  expect(trigger().querySelector('svg')).not.toBeNull()
})

test('instance and general picks say so', async () => {
  expect((await render({ scope: 'instance', confidence: 0.8 })).trigger().textContent).toBe('Not about a squad')
  await dom!.cleanup()
  expect((await render({ scope: 'general', confidence: 0.66 })).trigger().textContent).toBe('General')
})

test("the user's correction replaces the model's pick", async () => {
  const { trigger } = await render({
    scope: 'general',
    confidence: 0.7,
    correction: { scope: 'squad', squadId: billing.id, squadName: 'Billing', at: '2026-10-08T00:00:00.000Z' },
  })
  expect(trigger().textContent).toBe('Billing·you')
  expect(trigger().getAttribute('aria-label')).toBe('Routing: Billing, set by you. Change squad')
})

test('picking another squad sends the correction and shows it at once', async () => {
  let settle!: () => void
  const onCorrect = mock(
    (_pick: AssistantRoutingPick) =>
      new Promise((resolve) => {
        settle = () => resolve({})
      })
  )
  const f = await render({ scope: 'squad', squadId: chlea.id, squadName: 'Chlea', confidence: 0.91 }, onCorrect)
  await f.open()
  expect(f.option('No squad')).toBeDefined()
  expect(f.option('Chlea').getAttribute('aria-selected')).toBe('true')
  await dom!.act(async () => f.option('Billing').click())
  expect(onCorrect).toHaveBeenCalledWith({ scope: 'squad', squadId: billing.id })
  expect(f.trigger().textContent).toBe('Billing·you')
  await dom!.act(async () => settle())
})

test('No squad corrects to none; the current pick sends nothing', async () => {
  const f = await render({ scope: 'squad', squadId: chlea.id, squadName: 'Chlea', confidence: 0.91 })
  await f.open()
  await dom!.act(async () => f.option('Chlea').click())
  expect(f.onCorrect).not.toHaveBeenCalled()
  await f.open()
  await dom!.act(async () => f.option('No squad').click())
  expect(f.onCorrect).toHaveBeenCalledWith({ scope: 'none' })
})

test('a failed correction goes back to the saved pick and says why', async () => {
  const f = await render(
    { scope: 'general', confidence: 0.7 },
    mock(async () => {
      throw new Error('Squad not found')
    })
  )
  await f.open()
  await dom!.act(async () => f.option('Chlea').click())
  expect(f.trigger().textContent).toBe('General')
  expect(f.container.querySelector('[role="alert"]')?.textContent).toBe('Squad not found')
})

test('a general hint shows no chip on the message unless the user corrected it', async () => {
  dom = await acquireDomHarness({ url: 'http://localhost' })
  const { root, container } = dom.createRoot()
  const api = { correctRouting: mock(async () => ({})) }
  const show = (hint: AssistantRoutingHint) =>
    dom!.act(async () =>
      root.render(
        <QueryClientProvider client={new QueryClient()}>
          <AssistantMessageRouting
            conversationId="c1"
            messageId="m1"
            content="Fix it"
            hint={hint}
            latest
            onDraft={() => {}}
            api={api as never}
          />
        </QueryClientProvider>
      )
    )
  await show({ scope: 'general', confidence: 0.92 })
  expect(container.querySelector('button[role="combobox"]')).toBeNull()
  await show({
    scope: 'general',
    confidence: 0.92,
    correction: { scope: 'squad', squadId: chlea.id, squadName: 'Chlea', at: '2026-10-08T00:00:00.000Z' },
  })
  expect(container.querySelector('button[role="combobox"]')).not.toBeNull()
  await show({ scope: 'squad', squadId: chlea.id, squadName: 'Chlea', confidence: 0.94 })
  expect(container.querySelector('button[role="combobox"]')?.textContent).toBe('Chlea')
})

test('on an older message, picking a squad asks the Assistant to move it instead of correcting', async () => {
  dom = await acquireDomHarness({ url: 'http://localhost' })
  const { root, container } = dom.createRoot()
  const onAskToMove = mock(() => {})
  await dom.act(async () =>
    root.render(
      <AssistantRoutingChip
        hint={{ scope: 'squad', squadId: chlea.id, squadName: 'Chlea', confidence: 0.9 }}
        squads={[chlea, billing]}
        onAskToMove={onAskToMove}
      />
    )
  )
  const trigger = container.querySelector<HTMLButtonElement>('button[role="combobox"]')!
  expect(trigger.getAttribute('aria-label')).toBe('Routing: Chlea. Ask the Assistant to move it')
  await dom.act(async () => trigger.click())
  await dom.act(async () => {
    await new Promise((resolve) => dom!.window.requestAnimationFrame(resolve))
  })
  const billingRow = [...dom.window.document.querySelectorAll<HTMLElement>('[role="option"]')].find((row) =>
    row.textContent?.startsWith('Billing')
  )!
  await dom.act(async () => billingRow.click())
  expect(onAskToMove).toHaveBeenCalledWith({ scope: 'squad', squadId: billing.id, squadName: 'Billing' })
  // Nothing was changed, so the chip still shows where it went.
  expect(trigger.textContent).toBe('Chlea')
})

test('the move request quotes the start of the message', () => {
  const chleaTarget = { scope: 'squad' as const, squadId: chlea.id, squadName: 'Chlea' }
  expect(assistantMoveRequest('Add  a dark\nmode toggle', chleaTarget, { ...chleaTarget, squadName: 'Billing' })).toBe(
    'Please move "Add a dark mode toggle" to Billing.'
  )
  expect(assistantMoveRequest('Add a dark mode toggle', chleaTarget, { scope: 'none' })).toBe(
    'Please move "Add a dark mode toggle" out of Chlea: it isn\'t for a squad.'
  )
  const long = assistantMoveRequest(`${'word '.repeat(40)}end`, chleaTarget, { scope: 'none' })
  expect(long).toStartWith('Please move "word word')
  expect(long).toContain('…" out of Chlea')
})

test('the latest message is the newest one the user sent, not a system note, and none while sending', () => {
  const human = (id: string, source: string) =>
    ({ kind: 'persisted', id, message: { id, role: 'human', metadata: { source } }, blocks: [] }) as never
  const reply = { kind: 'persisted', id: 'r', message: { id: 'r', role: 'assistant' }, blocks: [] } as never
  expect(latestAssistantUserMessageId([human('a', 'user_chat'), reply, human('b', 'user_chat'), reply])).toBe('b')
  expect(latestAssistantUserMessageId([human('a', 'user_chat'), human('n', 'assistant_routing_correction')])).toBe('a')
  expect(
    latestAssistantUserMessageId([
      human('a', 'user_chat'),
      { kind: 'pending', id: 'p', content: 'x', status: 'sending' },
    ])
  ).toBeNull()
  expect(
    latestAssistantUserMessageId([
      human('a', 'user_chat'),
      { kind: 'pending', id: 'p', content: 'x', status: 'failed' },
    ])
  ).toBe('a')
  expect(latestAssistantUserMessageId([])).toBeNull()
})

test("the composer pill shows the preview or the pick, and picking back the model's choice clears the pick", async () => {
  dom = await acquireDomHarness({ url: 'http://localhost' })
  const { root, container } = dom.createRoot()
  const client = new QueryClient()
  client.setQueryData(queryKeys.squads.list('active'), [
    { ...chlea, isAnonymous: false },
    { ...billing, isAnonymous: false },
  ] as never)
  const onPick = mock(() => {})
  const show = (props: Omit<React.ComponentProps<typeof AssistantDraftRouting>, 'onPick'>) =>
    dom!.act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <AssistantDraftRouting {...props} onPick={onPick} />
        </QueryClientProvider>
      )
    )
  const trigger = () => container.querySelector<HTMLButtonElement>('button[role="combobox"]')
  const pickRow = async (label: string) => {
    await dom!.act(async () => trigger()!.click())
    await dom!.act(async () => {
      await new Promise((resolve) => dom!.window.requestAnimationFrame(resolve))
    })
    const rows = [...dom!.window.document.querySelectorAll<HTMLElement>('[role="option"]')]
    await dom!.act(async () =>
      rows
        .filter((row) => row.textContent?.startsWith(label))
        .at(-1)!
        .click()
    )
  }
  // Nothing to say yet, or only "general": no pill.
  await show({ hint: null, pick: null })
  expect(trigger()).toBeNull()
  await show({ hint: { scope: 'general', confidence: 0.9 }, pick: null })
  expect(trigger()).toBeNull()

  const model = { scope: 'squad' as const, squadId: chlea.id, squadName: 'Chlea', confidence: 0.8 }
  await show({ hint: model, pick: null })
  expect(trigger()!.textContent).toBe('Chlea')
  expect(container.querySelector('[data-assistant-routing="draft"]')).not.toBeNull()
  await pickRow('Billing')
  expect(onPick).toHaveBeenLastCalledWith({ scope: 'squad', squadId: billing.id, squadName: 'Billing' })

  await show({ hint: model, pick: { scope: 'squad', squadId: billing.id, squadName: 'Billing' } })
  expect(trigger()!.textContent).toBe('Billing·you')
  await pickRow('Chlea')
  expect(onPick).toHaveBeenLastCalledWith(null)

  // Picked before the preview answered.
  await show({ hint: null, pick: { scope: 'none' } })
  expect(trigger()!.textContent).toBe('No squad·you')
})
