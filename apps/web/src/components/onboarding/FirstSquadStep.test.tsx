import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { acquireDomHarness } from '../../test/domHarness'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { onboardingQueryKeys } from '../../queryKeys'
import { FirstSquadStep } from './FirstSquadStep'
import type { OnboardingItem } from '../../api/onboarding'
import type { OnboardingItemMeta } from './OnboardingPage'

/**
 * Interactive tests only (no static-render block): FirstSquadStep is
 * inherently stateful (form -> mutation -> mutation), so every case needs
 * the real DOM + fetch-stub + act() harness OnboardingPage.test.tsx's
 * second describe block established, for the same mock.module-leakage
 * reasons documented there.
 */
const META: OnboardingItemMeta = {
  id: 'first_squad',
  title: 'Create your first squad',
  why: 'Squads are where agents work — nothing runs until one exists.',
  linkTo: '/squads',
  linkLabel: 'Squads',
}

function todoItem(): OnboardingItem {
  return { id: 'first_squad', required: true, state: 'todo' }
}

function doneItem(): OnboardingItem {
  return { id: 'first_squad', required: true, state: 'done' }
}

describe('FirstSquadStep', () => {
  let dom: Awaited<ReturnType<typeof acquireDomHarness>>
  const queryClients = new Set<QueryClient>()
  let container: HTMLDivElement
  let root: import('react-dom/client').Root
  let squadCreateCalls: Array<{ name: string; purpose: string; hostWorkspacePath?: string }>
  let chatCalls: Array<{ message: string; agentId?: string; scope?: { type: string; id?: string } }>
  let deleteCalls: string[]
  let chatShouldFail: boolean
  let createShouldFail: boolean
  let existingSquadsResponse: Array<{ id: string; name: string; managerAgentId: string | null; createdAt: string }>
  let createOptionsResponse: { runtime: string; defaultHostWorkspaceRoot?: string }

  beforeEach(async () => {
    dom = await acquireDomHarness({
      url: 'http://localhost/',
      configureWindow: (window) => Object.assign(window, { SyntaxError }),
      beforeUnmount: async () => {
        await Promise.all([...queryClients].map((client) => client.cancelQueries()))
        queryClients.forEach((client) => client.clear())
      },
    })
    squadCreateCalls = []
    chatCalls = []
    deleteCalls = []
    chatShouldFail = false
    createShouldFail = false
    existingSquadsResponse = []
    createOptionsResponse = { runtime: 'docker-socket' }

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      const method = (init?.method ?? 'GET').toUpperCase()

      if (url.endsWith('/api/squad-presets')) {
        return Response.json([
          {
            id: 'engineering',
            name: 'Engineering',
            description: 'Build and maintain software.',
            purpose: 'Software development',
            defaultAgents: ['manager'],
            workflows: { default: { kind: 'preset', id: 'solo-coding', customizations: [] }, choices: [] },
          },
        ])
      }
      if (url.endsWith('/api/squads/create-options') && method === 'GET') {
        return Response.json(createOptionsResponse)
      }

      if (url.endsWith('/api/squads') && method === 'POST') {
        const body = JSON.parse(String(init?.body ?? '{}'))
        squadCreateCalls.push(body)
        if (createShouldFail) return Response.json({ error: 'boom' }, { status: 500 })
        // Squad.create() always creates the manager agent and sets managerAgentId
        // synchronously before returning (apps/core/src/entities/Squad.ts:248-256) —
        // the real API response always carries it.
        return Response.json(
          { id: 'squad-1', name: body.name, purpose: body.purpose, managerAgentId: 'squad-1-manager' },
          { status: 201 }
        )
      }
      if (url.endsWith('/api/squads') && method === 'GET') {
        return Response.json(existingSquadsResponse)
      }
      if (url.match(/\/api\/squads\/[^/]+$/) && method === 'DELETE') {
        deleteCalls.push(url)
        return new Response(null, { status: 204 })
      }
      if (url.endsWith('/api/chat') && method === 'POST') {
        const body = JSON.parse(String(init?.body ?? '{}'))
        chatCalls.push(body)
        if (chatShouldFail) return Response.json({ error: 'boom' }, { status: 500 })
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.close()
            },
          }),
          { status: 200, headers: { 'Content-Type': 'text/event-stream' } }
        )
      }
      return Response.json({})
    }) as typeof fetch
    ;({ container, root } = dom.createRoot())
  })

  afterEach(async () => {
    await dom.cleanup()
    queryClients.clear()
  })

  function renderStep(item: OnboardingItem) {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    queryClients.add(queryClient)
    return dom.act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <FirstSquadStep meta={META} item={item} onSkip={() => {}} onUnskip={() => {}} pending={false} />
        </QueryClientProvider>
      )
    })
  }

  async function flush() {
    await dom.act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }

  function collectByTag(root: Element, tag: string): Element[] {
    const found: Element[] = []
    const walk = (el: Element) => {
      for (const child of Array.from(el.children)) {
        if (child.tagName.toLowerCase() === tag) found.push(child)
        walk(child)
      }
    }
    walk(root)
    return found
  }

  function findById(root: Element, id: string): Element | undefined {
    let found: Element | undefined
    const walk = (el: Element) => {
      for (const child of Array.from(el.children)) {
        if (child.getAttribute('id') === id) found = child
        walk(child)
      }
    }
    walk(root)
    return found
  }

  function findByLabelText(text: string): HTMLElement {
    const labels = collectByTag(container, 'label')
    const label = labels.find((l) => l.textContent?.includes(text))
    if (!label) throw new Error(`No label found with text: ${text}`)
    const forId = label.getAttribute('for')
    if (!forId) throw new Error(`Label "${text}" has no "for" attribute`)
    const el = findById(container, forId)
    if (!el) throw new Error(`No element found for label "${text}" (id ${forId})`)
    return el as HTMLElement
  }

  function findButtonByText(text: string): HTMLButtonElement {
    const buttons = collectByTag(container, 'button')
    const button = buttons.find((b) => b.textContent === text)
    if (!button) throw new Error(`No button found with text: ${text}`)
    return button as HTMLButtonElement
  }

  // happy-dom's native <button type="submit"> click -> HTMLFormElement.requestSubmit()
  // -> checkValidity() path hits an internal happy-dom bug (querySelectorAll inside
  // getFormControlItems throws — unrelated to this component). Dispatch `submit`
  // directly on the form instead: React's synthetic event system still picks it up
  // via bubbling, and our onSubmit handlers call preventDefault() themselves.
  function submitForm(button: HTMLButtonElement) {
    let node: Element | null = button
    while (node && node.tagName.toLowerCase() !== 'form') node = node.parentElement
    if (!node) throw new Error('Submit button is not inside a form')
    node.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  }

  function setValue(el: HTMLElement, value: string) {
    const proto = el.tagName.toLowerCase() === 'textarea' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
    setter?.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }

  test('todo state renders name/purpose fields plus an optional repos textarea', async () => {
    await renderStep(todoItem())

    const nameField = findByLabelText('Squad name')
    const purposeField = findByLabelText('Purpose')
    const reposField = findByLabelText('Repositories')

    expect(nameField.tagName).toBe('INPUT')
    expect(purposeField.tagName).toBe('TEXTAREA')
    expect(reposField.tagName).toBe('TEXTAREA')
    expect(reposField.hasAttribute('required')).toBe(false)
    expect(container.textContent).not.toContain('Working directory')
  })

  test('creates with a name and an optional empty purpose', async () => {
    await renderStep(todoItem())
    await flush()
    await dom.act(async () => {
      const select = findByLabelText('Preset') as HTMLSelectElement
      expect(select.value).toBe('engineering')
      expect(select.options[0]!.textContent).toBe('No preset')
      expect(collectByTag(container, 'select')).toHaveLength(1)
      select.value = ''
      select.dispatchEvent(new Event('change', { bubbles: true }))
      setValue(findByLabelText('Squad name'), 'Research')
    })
    expect(findButtonByText('Create squad & send kickoff').disabled).toBe(false)
    await dom.act(async () => submitForm(findButtonByText('Create squad & send kickoff')))
    await flush()
    expect(squadCreateCalls).toEqual([
      { name: 'Research', purpose: '', metadata: { workflow: { kind: 'preset', id: 'solo', customizations: [] } } },
    ])
  })

  test('selecting a squad preset applies its type, members, and default flow without overwriting purpose', async () => {
    await renderStep(todoItem())
    await flush()
    await dom.act(async () => {
      await flush()
      setValue(findByLabelText('Squad name'), 'Platform')
      setValue(findByLabelText('Purpose'), 'Maintain our platform')
      const select = findByLabelText('Preset') as HTMLSelectElement
      select.value = 'engineering'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(container.textContent).toContain('Build and maintain software.')
    await dom.act(async () => submitForm(findButtonByText('Create squad & send kickoff')))
    await flush()
    expect(squadCreateCalls[0]).toEqual({
      name: 'Platform',
      purpose: 'Maintain our platform',
      squadPresetId: 'engineering',
      defaultAgents: ['manager'],
      metadata: { workflow: { kind: 'preset', id: 'solo-coding', customizations: [] } },
    })
  })

  test('returning to No preset clears the preset and restores Solo', async () => {
    await renderStep(todoItem())
    await flush()
    for (const value of ['engineering', '']) {
      await dom.act(async () => {
        const select = findByLabelText('Preset') as HTMLSelectElement
        select.value = value
        select.dispatchEvent(new Event('change', { bubbles: true }))
      })
    }
    await dom.act(async () => setValue(findByLabelText('Squad name'), 'Custom'))
    await dom.act(async () => submitForm(findButtonByText('Create squad & send kickoff')))
    await flush()
    expect(squadCreateCalls[0]).toEqual({
      name: 'Custom',
      purpose: 'Software development',
      metadata: { workflow: { kind: 'preset', id: 'solo', customizations: [] } },
    })
  })

  test('host runtime shows the default directory and submits an override', async () => {
    createOptionsResponse = {
      runtime: 'host',
      defaultHostWorkspaceRoot: '/home/tau/.tau/workspaces/squads',
    }
    await renderStep(todoItem())
    await flush()

    expect(container.textContent).toContain('/home/tau/.tau/workspaces/squads/<new squad id>')
    await flush()
    setValue(findByLabelText('Squad name'), 'Platform')
    setValue(findByLabelText('Purpose'), 'Ship the platform')
    setValue(findByLabelText('Working directory'), '/srv/platform')

    await dom.act(async () => submitForm(findButtonByText('Create squad & send kickoff')))
    await flush()

    expect(squadCreateCalls[0]).toEqual({
      name: 'Platform',
      purpose: 'Ship the platform',
      hostWorkspacePath: '/srv/platform',
      squadPresetId: 'engineering',
      defaultAgents: ['manager'],
      metadata: { workflow: { kind: 'preset', id: 'solo-coding', customizations: [] } },
    })
  })

  test('on success: creates the squad, sends the kickoff directly to the squad manager agent via the chat API, and invalidates the onboarding query', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    queryClients.add(queryClient)
    const invalidated: unknown[] = []
    const originalInvalidate = queryClient.invalidateQueries.bind(queryClient)
    queryClient.invalidateQueries = ((...args: Parameters<typeof originalInvalidate>) => {
      invalidated.push(args[0])
      return originalInvalidate(...args)
    }) as typeof queryClient.invalidateQueries

    await dom.act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <FirstSquadStep meta={META} item={todoItem()} onSkip={() => {}} onUnskip={() => {}} pending={false} />
        </QueryClientProvider>
      )
    })

    await flush()
    setValue(findByLabelText('Squad name'), 'Platform')
    setValue(findByLabelText('Purpose'), 'Ship the platform')
    setValue(findByLabelText('Repositories'), 'https://github.com/acme/api')

    const submit = findButtonByText('Create squad & send kickoff')
    await dom.act(async () => {
      submitForm(submit)
    })
    await flush()
    await flush()

    expect(squadCreateCalls).toEqual([
      {
        name: 'Platform',
        purpose: 'Ship the platform',
        squadPresetId: 'engineering',
        defaultAgents: ['manager'],
        metadata: { workflow: { kind: 'preset', id: 'solo-coding', customizations: [] } },
      },
    ])
    expect(chatCalls.length).toBe(1)
    // Directly to the manager agent — NOT `scope: { type: 'consultant', ... }`,
    // which spawns a fresh, non-persistent consultant agent per call server-side
    // (apps/core/src/routes/chat.ts:76-84) and never reaches the manager.
    expect(chatCalls[0].agentId).toBe('squad-1-manager')
    expect(chatCalls[0].scope).toBeUndefined()
    expect(chatCalls[0].message).toContain('https://github.com/acme/api')
    expect(invalidated).toContainEqual({ queryKey: onboardingQueryKeys.all })
  })

  test('send-failure keeps the created squad, shows the error inline with a retry button, and does not roll back', async () => {
    chatShouldFail = true
    await renderStep(todoItem())

    await flush()
    setValue(findByLabelText('Squad name'), 'Platform')
    setValue(findByLabelText('Purpose'), 'Ship the platform')

    const submit = findButtonByText('Create squad & send kickoff')
    await dom.act(async () => {
      submitForm(submit)
    })
    await flush()
    await flush()

    expect(squadCreateCalls.length).toBe(1)
    expect(deleteCalls.length).toBe(0)
    expect(container.textContent).toContain('Failed to send')

    const retry = findButtonByText('Retry')
    chatShouldFail = false
    await dom.act(async () => {
      retry.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await flush()
    await flush()

    expect(chatCalls.length).toBe(2)
    expect(squadCreateCalls.length).toBe(1) // no re-create on retry
  })

  test('when a squad already exists, renders the non-tracked "send your squad its first task" CTA with the same composer, targeting the manager agent', async () => {
    existingSquadsResponse = [
      {
        id: 'squad-existing',
        name: 'Existing Squad',
        managerAgentId: 'squad-existing-manager',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ]
    await renderStep(doneItem())
    await flush()

    expect(() => findByLabelText('Squad name')).toThrow()
    expect(container.textContent).toContain('send your squad its first task')

    setValue(findByLabelText('Repositories'), 'https://github.com/acme/web')
    const send = findButtonByText('Send')
    await dom.act(async () => {
      submitForm(send)
    })
    await flush()
    await flush()

    expect(squadCreateCalls.length).toBe(0)
    expect(chatCalls.length).toBe(1)
    expect(chatCalls[0].agentId).toBe('squad-existing-manager')
    expect(chatCalls[0].scope).toBeUndefined()
    expect(chatCalls[0].message).toContain('https://github.com/acme/web')
  })

  test('when several squads already exist, the "already exists" composer deliberately targets the most recently created one', async () => {
    // Array order is intentionally NOT chronological — an implementation that
    // naively picks `data[0]` would target the oldest (wrong) squad here.
    existingSquadsResponse = [
      {
        id: 'squad-old',
        name: 'Old Squad',
        managerAgentId: 'squad-old-manager',
        createdAt: '2020-01-01T00:00:00.000Z',
      },
      {
        id: 'squad-newest',
        name: 'Newest Squad',
        managerAgentId: 'squad-newest-manager',
        createdAt: '2026-06-01T00:00:00.000Z',
      },
      {
        id: 'squad-middle',
        name: 'Middle Squad',
        managerAgentId: 'squad-middle-manager',
        createdAt: '2023-01-01T00:00:00.000Z',
      },
    ]
    await renderStep(doneItem())
    await flush()

    const send = findButtonByText('Send')
    await dom.act(async () => {
      submitForm(send)
    })
    await flush()
    await flush()

    expect(chatCalls.length).toBe(1)
    expect(chatCalls[0].agentId).toBe('squad-newest-manager')
  })
})
