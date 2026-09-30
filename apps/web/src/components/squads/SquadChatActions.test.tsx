import { afterEach, expect, mock, test } from 'bun:test'
import { useState } from 'react'
import { acquireDomHarness } from '../../test/domHarness'
import { Modal } from '../Modal'
import { SquadChatActions } from './SquadChatActions'
let dom: Awaited<ReturnType<typeof acquireDomHarness>> | undefined
afterEach(async () => {
  await dom?.cleanup()
  dom = undefined
})
const defaults = {
  canCreateConsultant: false,
  canManageChats: true,
  canSpawnAgent: true,
  managingChats: false,
  onNewChat: () => {},
  onManageChats: () => {},
  onSpawnAgent: () => {},
}

test('permissions filter options and hide the trigger when no actions are available', async () => {
  dom = await acquireDomHarness({ url: 'http://localhost/squad' })
  const { root, container } = dom.createRoot()
  await dom.act(async () => root.render(<SquadChatActions {...defaults} canSpawnAgent={false} />))
  await dom.act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Chat options"]')!.click())
  expect([...dom.window.document.querySelectorAll('[role="menuitem"]')].map((row) => row.textContent)).toEqual([
    'Manage chats',
  ])
  await dom.act(async () =>
    root.render(<SquadChatActions {...defaults} canSpawnAgent={false} canManageChats={false} />)
  )
  expect(container.querySelector('[aria-label="Chat options"]')).toBeNull()
  expect(dom.window.document.querySelector('[role="menu"]')).toBeNull()
})

test('Spawn hands focus to its dialog; Manage restores trigger focus', async () => {
  dom = await acquireDomHarness({ url: 'http://localhost/squad' })
  const manage = mock()
  function Harness() {
    const [open, setOpen] = useState(false)
    return (
      <>
        <SquadChatActions {...defaults} onManageChats={manage} onSpawnAgent={() => setOpen(true)} />
        <Modal isOpen={open} onClose={() => setOpen(false)} title="Spawn agent">
          <input aria-label="Name" />
        </Modal>
      </>
    )
  }
  const { root, container } = dom.createRoot()
  await dom.act(async () => root.render(<Harness />))
  const trigger = container.querySelector<HTMLButtonElement>('[aria-label="Chat options"]')!
  await dom.act(async () => trigger.click())
  await dom.act(async () => dom!.window.document.querySelector<HTMLButtonElement>('[role="menuitem"]')!.click())
  expect(manage).toHaveBeenCalledTimes(1)
  expect(dom.window.document.activeElement).toBe(trigger)
  await dom.act(async () => trigger.click())
  await dom.act(async () =>
    [...dom!.window.document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')][1]!.click()
  )
  expect(dom.window.document.activeElement?.getAttribute('role')).toBe('dialog')
  expect(dom.window.document.activeElement?.getAttribute('aria-label')).toBe('Spawn agent')
  expect(trigger.getAttribute('aria-expanded')).toBe('false')
})
