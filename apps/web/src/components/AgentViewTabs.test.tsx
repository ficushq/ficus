import { acquireDomHarness } from '../test/domHarness'
import { afterEach, expect, mock, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { AgentViewTabs, type AgentViewTabItem } from './AgentViewTabs'

let dom: Awaited<ReturnType<typeof acquireDomHarness>> | undefined
function TestIcon({ className }: { className?: string }) {
  return <svg className={className} aria-hidden="true" />
}
const tabs: AgentViewTabItem<'chat' | 'inbox' | 'subagents'>[] = [
  { value: 'chat', label: 'Chat', icon: TestIcon },
  { value: 'inbox', label: 'Inbox', icon: TestIcon },
  { value: 'subagents', label: 'Subagents', icon: TestIcon, activeCount: 2 },
]
afterEach(async () => {
  await dom?.cleanup()
  dom = undefined
})

test('preserves desktop tabs/counts and offers themed mobile and tablet triggers instead of a native select', () => {
  const html = renderToStaticMarkup(<AgentViewTabs activeTab="inbox" onChange={mock()} tabs={tabs} />)
  expect(html).toContain('hidden lg:flex')
  expect(html).toContain('hidden md:block lg:hidden')
  expect(html).toContain('md:hidden')
  expect(html).toContain('aria-pressed="true"')
  expect(html).toContain('bg-accent text-on-accent')
  expect(html).toContain('aria-label="Subagents, 2 active subagents"')
  expect(html).toContain('animate-pulse')
  expect(html).not.toContain('<select')
  expect(html).toContain('aria-label="Agent view"')
})

for (const label of ['Agent view', 'Conversation options, Inbox view']) {
  test(`${label}: selected initial focus, arrows highlight only, Enter commits once, Escape restores focus`, async () => {
    dom = await acquireDomHarness({ url: 'http://localhost/chat' })
    const { container, root } = dom.createRoot()
    const changes = mock()
    await dom.act(async () => root.render(<AgentViewTabs activeTab="inbox" onChange={changes} tabs={tabs} />))
    const trigger = container.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!
    await dom.act(async () => trigger.click())
    await dom.act(async () => {
      await new Promise((resolve) => dom!.window.requestAnimationFrame(resolve))
    })
    expect(dom.window.document.activeElement?.textContent).toBe('Inbox')
    const key = async (key: string) =>
      dom!.act(async () =>
        dom!.window.document.activeElement!.dispatchEvent(
          new dom!.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
        )
      )
    await key('End')
    expect(dom.window.document.activeElement?.getAttribute('aria-label')).toBe('Subagents, 2 active subagents')
    expect(changes).not.toHaveBeenCalled()
    await key('Enter')
    expect(changes).toHaveBeenCalledTimes(1)
    expect(changes).toHaveBeenCalledWith('subagents')
    expect(dom.window.document.activeElement).toBe(trigger)
    await dom.act(async () => trigger.click())
    await key('Escape')
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(dom.window.document.activeElement).toBe(trigger)
  })
}
