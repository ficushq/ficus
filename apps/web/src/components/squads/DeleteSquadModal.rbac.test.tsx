import { beforeEach, describe, expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { acquireDomHarness } from '../../test/domHarness'
import { MemoryRouter } from 'react-router-dom'
import { queryKeys } from '../../queryKeys'

let permissions = new Set<string>()

const { DeleteSquadModal } = await import('./DeleteSquadModal')

async function renderModal() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  queryClient.setQueryData(queryKeys.auth.permissions('squad-1'), { permissions: [...permissions] })

  const dom = await acquireDomHarness({ url: 'http://localhost/squads/squad-1' })
  const rendered = dom.createRoot()
  try {
    await dom.act(async () =>
      rendered.root.render(
        <MemoryRouter>
          <QueryClientProvider client={queryClient}>
            <DeleteSquadModal isOpen onClose={() => undefined} squadId="squad-1" squadName="Ficus" />
          </QueryClientProvider>
        </MemoryRouter>
      )
    )
    return dom.window.document.body.innerHTML
  } finally {
    await queryClient.cancelQueries()
    queryClient.clear()
    await dom.act(async () => Bun.sleep(10))
    await dom.cleanup()
  }
}

describe('DeleteSquadModal RBAC gating', () => {
  beforeEach(() => {
    permissions = new Set<string>()
  })

  test('keeps destructive submit disabled unless squads:delete is allowed', async () => {
    expect(await renderModal()).toContain('You do not have permission to delete squads')

    permissions.add('squads:delete')
    expect(await renderModal()).toContain('Archive squad')
  })
})
