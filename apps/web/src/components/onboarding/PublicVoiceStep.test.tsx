import { expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router'
import { fireEvent, isInaccessible } from '@testing-library/dom'
import type { Squad } from '@ficus/shared'
import { acquireDomHarness } from '../../test/domHarness'
import { queries } from '../../queryOptions'
import { PublicVoiceStep } from './PublicVoiceStep'

const result = {
  login: 'octo',
  draft: { base: 'Use complete sentences.', surfaces: {} },
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
  bytes: 23,
  maxBytes: 2000,
}
for (const scenario of ['created', 'recent', 'none', 'collision', 'assignment-failure'] as const)
  test(`onboarding voice save: ${scenario}`, async () => {
    const dom = await acquireDomHarness({ url: 'http://localhost' })
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })

    client.setQueryData(queries.publicVoices.githubAccounts().queryKey, [
      {
        id: 'account',
        login: 'octo',
      },
    ])
    const squads =
      scenario === 'none'
        ? []
        : [
            { id: 'older', name: 'Older', createdAt: '2025-01-01' },
            { id: 'recent', name: 'Recent', createdAt: '2026-01-01' },
          ]
    client.setQueryData(queries.squads.list().queryKey, squads)
    const original = globalThis.fetch
    const calls: Array<{ url: string; method: string; body: any }> = []
    let assignmentFailed = false
    globalThis.fetch = (async (url, init) => {
      const request = {
        url: String(url),
        method: init?.method ?? 'GET',
        body: init?.body ? JSON.parse(String(init.body)) : null,
      }
      calls.push(request)
      if (request.method === 'GET')
        return Response.json(request.url.endsWith('/github-accounts') ? [{ id: 'account', login: 'octo' }] : squads)
      if (request.url.endsWith('/derive')) return Response.json(result)
      if (request.url.endsWith('/public-voices'))
        return scenario === 'collision'
          ? Response.json({ error: 'Voice profile "from-github" already exists' }, { status: 409 })
          : Response.json({ id: 'from-github', name: 'From GitHub' }, { status: 201 })
      if (scenario === 'assignment-failure' && !assignmentFailed) {
        assignmentFailed = true
        return Response.json({ error: 'Forbidden' }, { status: 403 })
      }
      return Response.json({ voiceId: 'from-github' })
    }) as typeof fetch
    try {
      const { root, container } = dom.createRoot()
      await dom.act(async () =>
        root.render(
          <QueryClientProvider client={client}>
            <MemoryRouter>
              <PublicVoiceStep
                githubDone
                createdSquad={scenario === 'created' ? ({ id: 'created', name: 'Created here' } as Squad) : null}
                onConnectGitHub={() => {}}
              />
            </MemoryRouter>
          </QueryClientProvider>
        )
      )
      const click = async (text: string) =>
        dom.act(async () => {
          ;[...container.querySelectorAll('button')].find((b) => b.textContent === text)!.click()
          await new Promise((r) => setTimeout(r, 15))
        })
      await click('Derive')
      await click('Use this draft')
      expect(isInaccessible(container.querySelector('[aria-label="GitHub login"]')!)).toBe(true)
      expect(isInaccessible(container.querySelector('[aria-label="Voice"]')!)).toBe(false)
      if (scenario === 'none') {
        await click('Back to derivation')
        expect(isInaccessible(container.querySelector('[aria-label="GitHub login"]')!)).toBe(false)
        await click('Use this draft')
      }
      expect(container.querySelector<HTMLInputElement>('[aria-label="Profile name"]')!.value).toBe('From GitHub')
      expect(container.querySelector<HTMLTextAreaElement>('[aria-label="Voice"]')!.value).toBe(result.draft.base)
      const target = scenario === 'created' ? 'Created here' : 'Recent'
      await click(scenario === 'none' ? 'Save profile' : `Save and use for ${target}`)
      const saves = calls.filter((c) => c.method !== 'GET' && !c.url.endsWith('/derive'))
      expect(saves[0]).toEqual({
        url: 'http://localhost/api/public-voices',
        method: 'POST',
        body: { id: 'from-github', name: 'From GitHub', description: null, base: result.draft.base, surfaces: {} },
      })
      expect(calls.some((c) => c.method === 'PUT')).toBe(false)
      if (scenario === 'collision') {
        expect(container.textContent).toContain('already exists')
        expect(saves.length).toBe(1)
        await dom.act(async () =>
          fireEvent.input(container.querySelector('[aria-label="Profile name"]')!, {
            target: { value: 'Another voice' },
          })
        )
        expect(container.textContent).toContain('another-voice')
      } else if (scenario === 'none') {
        expect(saves.length).toBe(1)
        expect(container.textContent).toContain('Settings → Voices')
        await dom.act(async () => client.setQueryData(queries.squads.list().queryKey, [{ id: 'later', name: 'Later' }]))
        expect(calls.filter((c) => c.method === 'PATCH').length).toBe(0)
      } else {
        expect(saves[1]).toEqual({
          url: `http://localhost/api/squads/${scenario === 'created' ? 'created' : 'recent'}/voice`,
          method: 'PATCH',
          body: { voiceId: 'from-github' },
        })
        if (scenario === 'assignment-failure') {
          expect(container.textContent).toContain('Profile saved; could not assign it to Recent: Forbidden')
          expect(container.textContent).not.toContain('From GitHub is now used by')
          await dom.act(async () =>
            client.setQueryData(queries.squads.list().queryKey, [
              { id: 'different', name: 'Different', createdAt: '2999-01-01' },
            ])
          )
          await click('Retry assignment')
          expect(calls.filter((c) => c.method === 'POST' && !c.url.endsWith('/derive')).length).toBe(1)
          expect(calls.filter((c) => c.method === 'PATCH').length).toBe(2)
          expect(calls.filter((c) => c.method === 'PATCH').at(-1)!.url).toBe('http://localhost/api/squads/recent/voice')
        }
        expect(container.textContent).toContain(`From GitHub is now used by ${target}`)
      }
    } finally {
      globalThis.fetch = original
      client.clear()
      await dom.cleanup()
    }
  })

test('gated step opens GitHub setup and never shows the derivation form', async () => {
  const dom = await acquireDomHarness({ url: 'http://localhost' })
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } })
  let opened = 0
  client.setQueryData(queries.squads.list().queryKey, [])

  client.setQueryData(queries.publicVoices.githubAccounts().queryKey, [])
  try {
    const { root, container } = dom.createRoot()
    await dom.act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <PublicVoiceStep githubDone={false} createdSquad={null} onConnectGitHub={() => opened++} />
        </QueryClientProvider>
      )
    )
    expect(container.textContent).toContain('Connect GitHub first.')
    expect(container.querySelector('[aria-label="GitHub login"]')).toBeNull()
    await dom.act(async () => container.querySelector<HTMLButtonElement>('button')!.click())
    expect(opened).toBe(1)
  } finally {
    client.clear()
    await dom.cleanup()
  }
})
