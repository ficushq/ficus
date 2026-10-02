import { afterEach, describe, expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { fireEvent } from '@testing-library/dom'
import { acquireDomHarness } from '../../test/domHarness'
import { queryKeys } from '../../queryKeys'
import { createBlankWorkflow, type CreateSquadInput } from '@ficus/shared'
import { CreateSquadModal } from './CreateSquadModal'

describe('CreateSquadModal', () => {
  let cleanup: (() => Promise<void>) | undefined
  let dom: Awaited<ReturnType<typeof acquireDomHarness>>
  let submitted: CreateSquadInput | undefined
  let requests: string[]
  const inlineDefault = { kind: 'inline', definition: createBlankWorkflow() }

  afterEach(async () => {
    await cleanup?.()
    cleanup = undefined
  })

  async function render(runtime: 'docker-socket' | 'host', withPreset = false) {
    dom = await acquireDomHarness({ url: 'http://localhost/squads' })
    submitted = undefined
    requests = []
    globalThis.fetch = (async (input, init) => {
      requests.push(String(input))
      if (init?.method === 'POST') {
        submitted = JSON.parse(String(init.body))
        return Response.json({ id: 'new-squad', name: 'Research', purpose: '' })
      }
      return Response.json([])
    }) as typeof fetch
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
            { id: 'research', name: 'Research', defaultAgents: [], workflows: { default: inlineDefault, choices: [] } },
            { id: 'legacy', name: 'Legacy', defaultAgents: [] },
          ]
        : []
    )
    queryClient.setQueryData(queryKeys.squads.list(), [])
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

  test('labels the empty preset option No preset', async () => {
    const body = await render('docker-socket')
    expect(body.querySelector('#squad-preset option')!.textContent).toBe('No preset')
  })

  test('offers No preset and no workflow control in either mode, without fetching workflows', async () => {
    const body = await render('host', true)
    const preset = body.querySelector<HTMLSelectElement>('#squad-preset')!
    for (const value of ['', 'engineering', 'research', '']) {
      await dom.act(async () => fireEvent.change(preset, { target: { value } }))
      expect(body.querySelectorAll('select').length).toBe(1)
      expect(body.textContent).not.toContain('Choose a workflow')
      expect([...body.querySelectorAll('label')].some((label) => label.textContent?.includes('Workflow'))).toBe(false)
    }
    expect(requests.some((url) => url.includes('/workflows'))).toBe(false)
  })

  test.each([
    {
      choices: ['engineering'],
      expectedPreset: 'engineering',
      workflow: { kind: 'preset', id: 'solo-coding', customizations: [] },
    },
    { choices: ['engineering', 'research'], expectedPreset: 'research', workflow: inlineDefault },
    {
      choices: ['engineering', ''],
      expectedPreset: undefined,
      workflow: { kind: 'preset', id: 'solo', customizations: [] },
    },
    {
      choices: ['research', '', 'engineering'],
      expectedPreset: 'engineering',
      workflow: { kind: 'preset', id: 'solo-coding', customizations: [] },
    },
    {
      choices: ['engineering', 'legacy'],
      expectedPreset: 'legacy',
      workflow: { kind: 'preset', id: 'solo', customizations: [] },
    },
  ])('submits the current default after selecting $choices', async ({ choices, expectedPreset, workflow }) => {
    const body = await render('docker-socket', true)
    for (const value of choices) {
      await dom.act(async () => fireEvent.change(body.querySelector('#squad-preset')!, { target: { value } }))
    }
    await dom.act(async () => fireEvent.change(body.querySelector('#squad-name')!, { target: { value: 'Research' } }))
    await dom.act(async () => fireEvent.submit(body.querySelector('form')!))
    expect(submitted?.squadPresetId).toBe(expectedPreset)
    expect(submitted?.metadata?.workflow).toEqual(workflow)
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
    const submit = body.querySelector<HTMLButtonElement>('button[type="submit"]')!
    expect(submit.disabled).toBe(true)
    await dom.act(async () => fireEvent.change(body.querySelector('#squad-name')!, { target: { value: 'Research' } }))
    expect(submit.disabled).toBe(false)
    expect(body.textContent).toContain('Purpose (optional)')
    expect(body.textContent).toContain('Strongly encouraged')
    expect(body.textContent).not.toContain('No default workflow')
    expect(body.querySelectorAll('select:not(#squad-preset)').length).toBe(0)
    await dom.act(async () => fireEvent.submit(body.querySelector('form')!))
    expect(submitted).toMatchObject({ name: 'Research', purpose: '' })
    expect(submitted).toMatchObject({ metadata: { workflow: { kind: 'preset', id: 'solo' } } })
  })
})
