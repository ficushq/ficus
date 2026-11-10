import { afterEach, expect, test } from 'bun:test'
import { fireEvent } from '@testing-library/dom'
import { MemoryRouter } from 'react-router'
import type { Agent } from '@ficus/shared'
import { acquireDomHarness } from '../test/domHarness'
import { AssistantConversationSwitcher } from './AssistantConversations'

let dom: Awaited<ReturnType<typeof acquireDomHarness>> | undefined
afterEach(async () => {
  await dom?.cleanup()
  dom = undefined
})

const agent = {
  id: 'a1',
  agentTypeId: 'system-manager',
  metadata: { purpose: 'Plan the launch' },
  updatedAt: '2026-11-01T10:00:00.000Z',
} as unknown as Agent

test('each new open request opens the list with an empty search; 0 never opens it', async () => {
  dom = await acquireDomHarness({ url: 'http://localhost/' })
  const { root } = dom.createRoot()
  const document = dom.window.document
  const show = (openRequest: number) =>
    dom!.act(async () => {
      root.render(
        <MemoryRouter>
          <AssistantConversationSwitcher
            agents={[agent]}
            onSelect={() => {}}
            onNew={() => {}}
            canCreate
            openRequest={openRequest}
          />
        </MemoryRouter>
      )
    })
  const search = () => document.querySelector<HTMLInputElement>('input[aria-label="Search assistant conversations"]')
  const trigger = () => document.querySelector<HTMLButtonElement>('button[title="Switch conversation"]')!
  const isOpen = () => trigger().getAttribute('aria-expanded') === 'true'

  await show(0)
  expect(isOpen()).toBe(false)

  await show(1)
  expect(isOpen()).toBe(true)
  await dom.act(async () => {
    fireEvent.change(search()!, { target: { value: 'missing' } })
  })
  expect(search()!.value).toBe('missing')

  // Closing and re-rendering with the same request keeps it closed.
  await dom.act(async () => {
    trigger().click()
  })
  expect(isOpen()).toBe(false)
  await show(1)
  expect(isOpen()).toBe(false)

  await show(2)
  expect(isOpen()).toBe(true)
  expect(search()!.value).toBe('')
})
