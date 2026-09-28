import { afterEach, describe, expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { fireEvent } from '@testing-library/dom'
import { acquireDomHarness } from '../../test/domHarness'
import { queryKeys } from '../../queryKeys'
import { createBlankWorkflow } from '@ficus/shared'
import { CreateSquadModal } from './CreateSquadModal'

describe('CreateSquadModal host workspace field', () => {
  let cleanup: (() => Promise<void>) | undefined
  let dom: Awaited<ReturnType<typeof acquireDomHarness>>

  afterEach(async () => {
    await cleanup?.()
    cleanup = undefined
  })

  async function render(runtime: 'docker-socket' | 'host', withPreset = false) {
    dom = await acquireDomHarness({ url: 'http://localhost/squads' })
    const rendered = dom.createRoot()
    const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } })
    queryClient.setQueryData(
      queryKeys.squadPresets.list(),
      withPreset
        ? [
            {
              id: 'engineering',
              name: 'Engineering',
              defaultAgents: [],
              workflows: {
                default: { kind: 'preset', id: 'solo-coding', customizations: [] },
                guidance: '',
                choices: [{ when: 'Routine code', source: { kind: 'preset', id: 'solo-coding', customizations: [] } }],
              },
            },
          ]
        : []
    )
    queryClient.setQueryData(queryKeys.squads.list(), [])
    queryClient.setQueryData(queryKeys.workflows.list(), [
      { id: 'solo', definition: { ...createBlankWorkflow(), name: 'Solo' } },
      { id: 'solo-coding', definition: { ...createBlankWorkflow(), name: 'Solo Coding' } },
    ])
    queryClient.setQueryData(queryKeys.squads.createOptions(), {
      runtime,
      ...(runtime === 'host' ? { defaultHostWorkspaceRoot: '/home/tau/.tau/workspaces/squads' } : {}),
    })
    cleanup = async () => {
      await dom.cleanup()
      queryClient.clear()
    }

    await dom.act(async () => {
      rendered.root.render(
        <MemoryRouter>
          <QueryClientProvider client={queryClient}>
            <CreateSquadModal isOpen onClose={() => {}} />
          </QueryClientProvider>
        </MemoryRouter>
      )
    })
    return dom.window.document.body
  }

  test('choosing a squad preset selects its workflow default and going back restores Solo', async () => {
    const body = await render('host', true)
    const preset = body.querySelector('#squad-preset')!
    await dom.act(async () => {
      fireEvent.change(preset, { target: { value: 'engineering' } })
    })
    const picker = [...body.querySelectorAll('select')].find((select) => select !== preset)!
    expect(picker.value).toBe('solo-coding')
    expect(body.textContent).toContain('Includes 1 recommended workflows')
    await dom.act(async () => {
      fireEvent.change(preset, { target: { value: '' } })
    })
    expect(picker.value).toBe('solo')
  })

  test('hides the working directory outside host runtime', async () => {
    const body = await render('docker-socket')
    expect(body.textContent).not.toContain('Working directory')
  })

  test('shows the server-derived default root in host runtime', async () => {
    const body = await render('host')
    expect(body.textContent).toContain('Working directory')
    expect(body.textContent).toContain('/home/tau/.tau/workspaces/squads/<new squad id>')
  })

  test('submits with a name alone and the Solo workflow', async () => {
    const body = await render('docker-socket')
    const originalFetch = globalThis.fetch
    let submitted: unknown
    globalThis.fetch = (async (_input, init) => {
      if (init?.method === 'POST') {
        submitted = JSON.parse(String(init.body))
        return Response.json({ id: 'new-squad', name: 'Research', purpose: '' })
      }
      return Response.json([])
    }) as typeof fetch
    try {
      const submit = body.querySelector<HTMLButtonElement>('button[type="submit"]')!
      expect(submit.disabled).toBe(true)
      await dom.act(async () => fireEvent.change(body.querySelector('#squad-name')!, { target: { value: 'Research' } }))
      expect(submit.disabled).toBe(false)
      expect(body.textContent).toContain('Purpose (optional)')
      expect(body.textContent).toContain('Strongly encouraged')
      expect(body.textContent).not.toContain('No default workflow')
      expect(body.querySelector<HTMLSelectElement>('select:not(#squad-preset)')!.value).toBe('solo')
      await dom.act(async () => fireEvent.submit(body.querySelector('form')!))
      expect(submitted).toMatchObject({ name: 'Research', purpose: '' })
      expect(submitted).toMatchObject({ metadata: { workflow: { kind: 'preset', id: 'solo' } } })
    } finally {
      await cleanup?.()
      cleanup = undefined
      globalThis.fetch = originalFetch
    }
  })
})
