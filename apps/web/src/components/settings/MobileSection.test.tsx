import { afterEach, expect, test } from 'bun:test'
import { act } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { acquireDomHarness } from '../../test/domHarness'
import { PermissionsProvider } from '../../hooks/usePermissions'
import { serverConnectionQueryKeys } from '../../queryKeys'
import { MobileSection } from './MobileSection'
let cleanup: (() => Promise<void>) | undefined
afterEach(async () => {
  await cleanup?.()
  cleanup = undefined
})
for (const admin of [false, true]) {
  test(`personal Mobile never starts a protected relay query (${admin ? 'admin' : 'member'})`, async () => {
    const dom = await acquireDomHarness({ url: 'https://ficus.example.com/settings?section=mobile' })
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    cleanup = async () => {
      await dom.cleanup()
      client.clear()
    }
    const { root, container } = dom.createRoot()
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <MemoryRouter>
            <PermissionsProvider
              usePermissions={() => ({
                permissions: admin ? ['settings:read'] : [],
                identity: { type: 'user', userId: 'member' },
                can: () => admin,
                isLoading: false,
                isError: false,
              })}
            >
              <MobileSection />
            </PermissionsProvider>
          </MemoryRouter>
        </QueryClientProvider>
      )
    )
    expect(container.textContent).toContain('Ficus, to go.')
    expect(container.textContent).not.toContain('Connection & Pro coverage')
    expect(client.getQueryCache().find({ queryKey: serverConnectionQueryKeys.status() })).toBeUndefined()
    expect(!!container.querySelector('a[href="/settings?section=mobile-pro"]')).toBe(admin)
  })
}
