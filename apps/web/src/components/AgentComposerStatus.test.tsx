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
      status="running"
      context={{ percent: 25.4, tokens: 254_000, contextWindow: 1_000_000 }}
      canManageSession={false}
      onCompact={() => undefined}
      onReset={() => undefined}
    />
  )
  expect(html).toContain('aria-label="Context 25% used"')
  expect(html).toContain('<circle')
  expect(html).toContain('>25%<')
  expect(html).toContain('title="Context 25.4% used · 254.0k of 1.0M tokens"')
  expect(html).not.toContain('$')
  expect(html).not.toContain('role="status"')
})

test('the label beside the ring is a whole percent; the tooltip keeps the decimal and the tokens', () => {
  // Two consecutive persisted messages of a live turn, as captured from a running agent.
  const render = (percent: number, tokens: number) => {
    const html = renderToStaticMarkup(
      <AgentComposerStatus
        status="running"
        context={{ percent, tokens, contextWindow: 1_000_000 }}
        canManageSession={false}
        onCompact={() => undefined}
        onReset={() => undefined}
      />
    )
    return {
      label: html.match(/aria-label="(Context [^"]+)"/)?.[1],
      text: html.match(/<\/svg><span>([^<]*)<\/span>/)?.[1],
      title: html.match(/title="(Context [^"]+)"/)?.[1],
    }
  }
  expect(render(7.1679, 71_679)).toEqual({
    label: 'Context 7% used',
    text: '7%',
    title: 'Context 7.2% used · 71.7k of 1.0M tokens',
  })
  expect(render(7.2606, 72_606)).toEqual({
    label: 'Context 7% used',
    text: '7%',
    title: 'Context 7.3% used · 72.6k of 1.0M tokens',
  })
  // Rounds rather than truncates, so the label agrees with the tooltip's decimal.
  expect(render(7.5, 75_000).text).toBe('8%')
})

test('the ring opens the numbers and the session actions, offered only when the agent is idle', async () => {
  dom = await acquireDomHarness({ url: 'http://localhost' })
  const { root, container } = dom.createRoot()
  const onCompact = mock(() => undefined)
  const render = (canManageSession: boolean) =>
    dom!.act(async () =>
      root.render(
        <AgentComposerStatus
          context={{ percent: 62, tokens: 168_640, contextWindow: 272_000 }}
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
  // The context's own tokens, consistent with the percentage, out of the window.
  expect(dom.window.document.body.textContent).toContain('Context 62.0% used · 168.6k of 272.0k tokens')
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
