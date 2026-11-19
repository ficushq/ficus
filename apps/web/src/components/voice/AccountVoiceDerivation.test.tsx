import { expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router'
import { fireEvent, waitFor } from '@testing-library/dom'
import { queries } from '../../queryOptions'
import { acquireDomHarness } from '../../test/domHarness'
import { AccountVoiceDerivation } from './AccountVoiceDerivation'

const account = (id: string, login = id) => ({ id, login, displayName: `Display ${login}` })
async function fixture(
  accounts: unknown[],
  action: (container: HTMLElement, dom: Awaited<ReturnType<typeof acquireDomHarness>>) => Promise<void>
) {
  const dom = await acquireDomHarness({ url: 'http://localhost' })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(queries.publicVoices.githubAccounts().queryKey, accounts)
  try {
    const { root, container } = dom.createRoot()
    await dom.act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <MemoryRouter>
            <AccountVoiceDerivation />
          </MemoryRouter>
        </QueryClientProvider>
      )
    )
    await action(container, dom)
  } finally {
    client.clear()
    await dom.cleanup()
  }
}
test('no usable account links to Integrations without showing a derive form', async () => {
  await fixture([], async (container) => {
    expect(container.textContent).toContain('Connect a GitHub account first')
    expect(container.querySelector('a')?.getAttribute('href')).toBe('/settings?section=integrations')
    expect(container.querySelector('[aria-label="GitHub login"]')).toBeNull()
  })
})
test('single usable account is selected and prefilled but editable, and reads through the selected connection', async () => {
  const original = globalThis.fetch
  const calls: Array<{ url: string; body: any }> = []
  try {
    await fixture([account('selected', 'octocat')], async (container, dom) => {
      globalThis.fetch = (async (url, init) => {
        calls.push({ url: String(url), body: JSON.parse(String(init?.body)) })
        return Response.json({ error: 'github_connection_unavailable' }, { status: 422 })
      }) as typeof fetch

      const filters = [...container.querySelectorAll('details')].find((el) =>
        el.querySelector('summary')?.textContent?.includes('Filter activity')
      )
      expect(filters).toBeDefined()
      expect(filters!.open).toBe(false)
      expect(container.textContent).toContain('GitHub account to read through')
      expect(container.textContent).toContain('Display octocat')
      const login = container.querySelector<HTMLInputElement>('[aria-label="GitHub login"]')!
      expect(login.value).toBe('octocat')
      await dom.act(async () => fireEvent.input(login, { target: { value: 'another-person' } }))
      await dom.act(async () => {
        ;[...container.querySelectorAll('button')].find((b) => b.textContent === 'Derive')!.click()
        await new Promise((r) => setTimeout(r, 10))
      })
      await waitFor(() => expect(calls.length).toBe(1))
      expect(calls[0]).toEqual({
        url: 'http://localhost/api/public-voices/derive',
        body: { connectionId: 'selected', login: 'another-person', filters: {} },
      })
      expect(container.textContent).not.toContain('squad’s GitHub')
      expect(container.textContent).not.toContain("squad's GitHub")
    })
  } finally {
    globalThis.fetch = original
  }
})

test('choosing another account aborts an in-flight request and discards late results and completed drafts', async () => {
  await fixture([account('one'), account('two')], async (container, dom) => {
    const original = globalThis.fetch
    const pending: Array<{ resolve: (r: Response) => void; signal: AbortSignal }> = []
    globalThis.fetch = ((_, init) =>
      new Promise((resolve) => pending.push({ resolve, signal: init!.signal! }))) as typeof fetch
    const choose = async (login: string) => {
      await dom.act(async () =>
        container.querySelector<HTMLButtonElement>('[aria-label="GitHub account to read through"]')!.click()
      )
      await dom.act(async () =>
        [...dom.window.document.querySelectorAll<HTMLElement>('[role="option"]')]
          .find((el) => el.textContent?.includes(`Display ${login}`))!
          .click()
      )
    }
    const result = {
      login: 'one',
      draft: { base: 'The old account draft.', surfaces: {} },
      observations: [],
      exemplars: [],
      sampling: {
        filters: {},
        counts: {
          collected: 20,
          kept: 20,
          droppedByFilter: { date: 0, repository: 0 },
          droppedAsToolAuthored: 0,
          droppedAsTemplate: 0,
        },
        dateRange: {},
        publicRepositories: [],
        privateRepositories: [],
        pagingCapped: false,
      },
      bytes: 22,
      maxBytes: 2000,
    }
    try {
      expect(container.querySelector('[aria-label="GitHub login"]')).toBeNull()
      await choose('one')
      await dom.act(async () =>
        [...container.querySelectorAll('button')].find((b) => b.textContent === 'Derive')!.click()
      )
      await choose('two')
      expect(pending[0]!.signal.aborted).toBe(true)
      expect(container.querySelector<HTMLInputElement>('[aria-label="GitHub login"]')!.value).toBe('two')
      await dom.act(async () => {
        pending[0]!.resolve(Response.json(result))
        await new Promise((r) => setTimeout(r, 10))
      })
      expect(container.textContent).not.toContain('The old account draft.')
      await dom.act(async () =>
        [...container.querySelectorAll('button')].find((b) => b.textContent === 'Derive')!.click()
      )
      await dom.act(async () => {
        pending[1]!.resolve(Response.json(result))
        await new Promise((r) => setTimeout(r, 10))
      })
      expect(container.textContent).toContain('The old account draft.')
      await choose('one')
      expect(container.textContent).not.toContain('The old account draft.')
    } finally {
      globalThis.fetch = original
    }
  })
})
