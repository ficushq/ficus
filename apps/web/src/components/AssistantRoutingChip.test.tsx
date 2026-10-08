import { afterEach, expect, mock, test } from 'bun:test'
import type { AssistantRoutingHint } from '@ficus/shared'
import { acquireDomHarness } from '../test/domHarness'
import { AssistantRoutingChip, type AssistantRoutingPick } from './AssistantRoutingChip'

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

test('a squad pick reads as the squad and its confidence, with a squad icon', async () => {
  const { trigger } = await render({ scope: 'squad', squadId: chlea.id, squadName: 'Chlea', confidence: 0.914 })
  expect(trigger().textContent).toBe('Chlea·91%')
  expect(trigger().getAttribute('aria-label')).toBe('Routing: Chlea, 91% likely. Change squad')
  expect(trigger().className).toContain('ficus-button-secondary')
  expect(trigger().querySelector('svg')).not.toBeNull()
})

test('instance and general picks say so', async () => {
  expect((await render({ scope: 'instance', confidence: 0.8 })).trigger().textContent).toBe('Not about a squad·80%')
  await dom!.cleanup()
  expect((await render({ scope: 'general', confidence: 0.66 })).trigger().textContent).toBe('General·66%')
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
  expect(f.trigger().textContent).toBe('General·70%')
  expect(f.container.querySelector('[role="alert"]')?.textContent).toBe('Squad not found')
})
