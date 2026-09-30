import { afterEach, expect, mock, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { acquireDomHarness } from '../test/domHarness'
import { AgentComposerStatus } from './AgentComposerStatus'

let dom: Awaited<ReturnType<typeof acquireDomHarness>> | undefined
afterEach(async () => {
  await dom?.cleanup()
  dom = undefined
})

test('a small ring with the percentage; no cost, and no words for a plain running turn', () => {
  const html = renderToStaticMarkup(
    <AgentComposerStatus
      agentId="a1"
      status="running"
      context={{ percent: 25.4, tokens: 7_000_000 }}
      canManageSession={false}
      onCompact={() => undefined}
      onReset={() => undefined}
    />
  )
  expect(html).toContain('aria-label="Context 25% used"')
  expect(html).toContain('<circle')
  expect(html).toContain('>25%<')
  expect(html).not.toContain('$')
  expect(html).not.toContain('role="status"')
})

test('the ring opens the numbers and the session actions, offered only when the agent is idle', async () => {
  dom = await acquireDomHarness({ url: 'http://localhost' })
  const { root, container } = dom.createRoot()
  const onCompact = mock(() => undefined)
  const render = (canManageSession: boolean) =>
    dom!.act(async () =>
      root.render(
        <AgentComposerStatus
          agentId="a1"
          context={{ percent: 62, tokens: 1_200_000 }}
          canManageSession={canManageSession}
          onCompact={onCompact}
          onReset={() => undefined}
        />
      )
    )
  const open = async () => {
    await dom!.act(async () =>
      container.querySelector<HTMLButtonElement>('button[aria-label="Context 62% used"]')!.click()
    )
    await dom!.act(async () => {
      await new Promise((resolve) => dom!.window.requestAnimationFrame(resolve))
    })
  }
  const item = (label: string) =>
    [...dom!.window.document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((row) =>
      row.textContent?.includes(label)
    )

  await render(false)
  await open()
  expect(dom.window.document.body.textContent).toContain('Context 62% used · 1.2M tokens')
  expect(item('Compact context')?.getAttribute('aria-disabled') ?? String(item('Compact context')?.disabled)).toMatch(
    /true/
  )
  expect(item('Compact context')?.textContent).toContain('Available when the agent is idle')

  await dom.act(async () =>
    dom!.window.document.dispatchEvent(new dom!.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  )
  await render(true)
  await open()
  await dom.act(async () => item('Compact context')!.click())
  expect(onCompact).toHaveBeenCalledTimes(1)
})
