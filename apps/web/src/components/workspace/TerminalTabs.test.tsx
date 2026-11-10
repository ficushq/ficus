import { afterEach, expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { acquireDomHarness } from '../../test/domHarness'
import { queryKeys } from '../../queryKeys'
import { TerminalTabs } from './TerminalTabs'
import type { TerminalProps } from './Terminal'

let dom: Awaited<ReturnType<typeof acquireDomHarness>> | undefined
afterEach(async () => {
  await dom?.cleanup()
  dom = undefined
})

/** Stands in for the live terminal: shows which session a tab holds. */
function StubTerminal({ sessionId }: TerminalProps) {
  return <div data-terminal-session={sessionId ?? 'new'} />
}

async function renderTabs(sessions: Array<{ sessionId: string }>) {
  dom = await acquireDomHarness({ url: 'http://localhost/' })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  client.setQueryData(queryKeys.terminal.sessions('squad_s1'), sessions)
  const { root } = dom.createRoot()
  const show = () =>
    dom!.act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <TerminalTabs sandboxId="squad_s1" dependencies={{ TerminalComponent: StubTerminal }} />
        </QueryClientProvider>
      )
    })
  await show()
  const document = dom.window.document
  const labels = () =>
    [...document.querySelectorAll('span')]
      .map((span) => span.textContent?.trim())
      .filter((text) => text?.startsWith('Shell'))
  const terminals = () =>
    [...document.querySelectorAll('[data-terminal-session]')].map((element) =>
      element.getAttribute('data-terminal-session')
    )
  return { client, document, labels, terminals, show }
}

test('restores existing sessions as tabs once, and numbers a new tab after them', async () => {
  const { client, document, labels, terminals, show } = await renderTabs([{ sessionId: 's-a' }, { sessionId: 's-b' }])
  expect(labels()).toEqual(['Shell 1', 'Shell 2'])
  expect(terminals()).toEqual(['s-a', 's-b'])

  // A later refetch does not rebuild the tabs.
  client.setQueryData(queryKeys.terminal.sessions('squad_s1'), [{ sessionId: 's-c' }])
  await show()
  expect(terminals()).toEqual(['s-a', 's-b'])

  await dom!.act(async () => {
    document.querySelector<HTMLButtonElement>('button[title="New terminal"]')!.click()
  })
  expect(labels()).toEqual(['Shell 1', 'Shell 2', 'Shell 3'])
  expect(terminals()).toEqual(['s-a', 's-b', 'new'])
})

test('without sessions it starts one new tab, and the next is Shell 2', async () => {
  const { document, labels, terminals } = await renderTabs([])
  expect(labels()).toEqual(['Shell 1'])
  expect(terminals()).toEqual(['new'])
  await dom!.act(async () => {
    document.querySelector<HTMLButtonElement>('button[title="New terminal"]')!.click()
  })
  expect(labels()).toEqual(['Shell 1', 'Shell 2'])
})
