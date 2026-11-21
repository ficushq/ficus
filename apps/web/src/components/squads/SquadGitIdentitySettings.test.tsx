import { expect, test } from 'bun:test'
import { fireEvent } from '@testing-library/dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { acquireDomHarness } from '../../test/domHarness'
import { PermissionsProvider } from '../../hooks/usePermissions'
import { queries } from '../../queryOptions'
import { SquadGitIdentitySettings } from './SquadGitIdentitySettings'

for (const editable of [true, false]) {
  test(`workspace Git identity ${editable ? 'saves without a GitHub integration and preserves other metadata' : 'is read-only without squad update permission'}`, async () => {
    const dom = await acquireDomHarness({ url: 'http://localhost/squads/git-identity-test/settings' })
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } },
    })
    let squad = {
      id: 'git-identity-test',
      metadata: {
        githubIdentity: { gitUserName: 'Original', gitUserEmail: 'author@example.com' },
        github: [{ repo: 'owner/repo' }],
        integrationRules: { github: [] },
      },
    }
    const originalMetadata = squad.metadata
    client.setQueryData(queries.squads.basic(squad.id).queryKey, squad)
    const originalFetch = globalThis.fetch
    const patches: unknown[] = []
    globalThis.fetch = (async (input, init) => {
      expect(String(input)).toContain(`/squads/${squad.id}`)
      if (init?.method === 'PATCH') {
        const patch = JSON.parse(String(init.body))
        patches.push(patch)
        squad = { ...squad, ...patch }
      }
      return new Response(JSON.stringify(squad), { headers: { 'Content-Type': 'application/json' } })
    }) as typeof fetch
    const root = dom.createRoot()
    try {
      await dom.act(async () =>
        root.root.render(
          <PermissionsProvider
            usePermissions={() => ({
              can: (permission) => editable && permission === 'squads:update',
              permissions: editable ? ['squads:update'] : [],
              isLoading: false,
              isError: false,
            })}
          >
            <QueryClientProvider client={client}>
              <SquadGitIdentitySettings squadId={squad.id} />
            </QueryClientProvider>
          </PermissionsProvider>
        )
      )
      const input = document.querySelector<HTMLInputElement>('#squad-git-author-name')!
      expect(input.value).toBe('Original')
      expect(input.disabled).toBe(!editable)
      if (editable) {
        await dom.act(async () => fireEvent.input(input, { target: { value: 'New author' } }))
        await dom.act(async () =>
          [...document.querySelectorAll('button')].find((button) => button.textContent === 'Save identity')!.click()
        )
        expect(patches).toEqual([
          {
            metadata: {
              ...originalMetadata,
              githubIdentity: { gitUserName: 'New author', gitUserEmail: 'author@example.com' },
            },
          },
        ])
        expect(input.value).toBe('New author')
      } else {
        expect(document.body.textContent).not.toContain('Save identity')
        expect(patches).toEqual([])
      }
    } finally {
      globalThis.fetch = originalFetch
      await dom.cleanup()
      client.clear()
    }
  })
}
