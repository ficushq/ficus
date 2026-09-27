import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { fireEvent, waitFor } from '@testing-library/dom'
import { acquireDomHarness } from '../../test/domHarness'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { queryKeys, onboardingQueryKeys } from '../../queryKeys'
import { OnboardingPage } from './OnboardingPage'
import type { OnboardingStatus } from '../../api/onboarding'

/**
 * Seeds a real QueryClient (permissions + onboarding status caches) rather
 * than mocking `useOnboarding` or `../../api/onboarding` — this repo has
 * known cross-file mock.module leakage (see useOnboarding.test.tsx, which
 * owns the one mock of the onboarding API module), so every other onboarding
 * test file avoids mocking that shared surface. The interactive describe
 * block below stubs `fetch` directly instead, for the same reason.
 */
function mixedStatus(): OnboardingStatus {
  return {
    ready: false,
    items: [
      { id: 'ai_provider', required: true, state: 'done' },
      { id: 'first_squad', required: true, state: 'todo' },
      { id: 'github', required: false, state: 'skipped' },
    ],
  }
}

/** Core setup is complete; optional extras can still be configured. */
function coreSettledStatus(): OnboardingStatus {
  return {
    ready: true,
    items: [
      { id: 'ai_provider', required: true, state: 'done' },
      { id: 'github', required: false, state: 'skipped' },
      { id: 'first_squad', required: true, state: 'done' },
    ],
  }
}

function seededQueryClient(permissions: string[], onboardingStatus?: OnboardingStatus): QueryClient {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  queryClient.setQueryData(queryKeys.auth.permissions(undefined), { permissions })
  if (onboardingStatus) {
    queryClient.setQueryData(onboardingQueryKeys.status(), onboardingStatus)
  }
  return queryClient
}

function renderStatic(queryClient: QueryClient, entry = '/onboarding'): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[entry]}>
        <OnboardingPage />
      </MemoryRouter>
    </QueryClientProvider>
  )
}

describe('OnboardingPage — static rendering', () => {
  test('Open Tau links to the newest squad manager chat after onboarding', () => {
    const client = seededQueryClient(['settings:read'], coreSettledStatus())
    client.setQueryData(queryKeys.squads.list(), [
      { id: 'old', name: 'Older', managerAgentId: 'old-manager', createdAt: '2026-01-01' },
      { id: 'new', name: 'Test', managerAgentId: 'new-manager', createdAt: '2026-09-08' },
    ])
    const html = renderStatic(client)
    expect(html).toContain('href="/squads/test/agents?agent=new-manager"')
    client.clear()
  })

  test('shows optional setup consistently with all extra content initially collapsed', () => {
    const html = renderStatic(seededQueryClient(['settings:read'], mixedStatus()))

    // Core setup opens the first unfinished form inline.
    expect(html).toContain('Connect an AI provider')
    expect(html).not.toContain('/settings?section=providers')
    expect(html).toContain('Connect GitHub')
    expect(html).not.toContain('/settings?section=integrations')
    expect(html).toContain('Squad name')

    // Optional headers are discoverable from the start; their forms stay closed.
    expect(html).not.toContain('/settings?section=users')
    expect(html).toContain('Optional setup')
    expect(html).toContain('Voice &amp; memory')
    expect(html).toContain('Invite your team')
    expect(html).not.toContain('/settings?section=remote-hosts')
  })

  test('keeps the same collapsed optional rows after core setup is settled', () => {
    const html = renderStatic(seededQueryClient(['settings:read'], coreSettledStatus()))

    expect(html).toContain('Invite your team')
    expect(html).not.toContain('/settings?section=users')
    expect(html).not.toContain('/settings?section=integrations')
    expect(html).not.toContain('/settings?section=remote-hosts')
    expect(html).toContain('Connect a chat channel')
    expect(html).not.toContain('Add a remote host')
    // 'skipped' counts as settled, not just 'done' — the same rule `ready` uses.
    expect(html).not.toContain('Skip all follow-ups')
  })

  test('optional tools never show Skip; the skipped GitHub step shows Unskip', () => {
    const html = renderStatic(seededQueryClient(['settings:read'], coreSettledStatus()))

    // Optional tools have no skip actions; only the skipped GitHub step retains Unskip.
    expect((html.match(/>Skip</g) ?? []).length).toBe(0)
    expect((html.match(/>Unskip</g) ?? []).length).toBe(1)
  })

  test('connected GitHub is labeled Account connected rather than implying repository setup is done', () => {
    const status = coreSettledStatus()
    status.items.find((item) => item.id === 'github')!.state = 'done'
    const html = renderStatic(seededQueryClient(['settings:read'], status))
    const github = html.match(/<section[^>]*>(?:(?!<section)[\s\S])*?Connect GitHub[\s\S]*?<\/section>/)?.[0]
    expect(github).toBeDefined()
    expect(github).toContain('Account connected')
    expect(github).toContain('aria-expanded="false"')
    expect(github).not.toContain('>Skip<')
    expect(github).not.toContain('>Unskip<')
  })

  test('returning from GitHub authorization opens the repository-access setup step', () => {
    const status = coreSettledStatus()
    status.items.find((item) => item.id === 'github')!.state = 'done'
    const html = renderStatic(seededQueryClient(['settings:read'], status), '/onboarding?setup=github')
    const github = html.match(/<section[^>]*>(?:(?!<section)[\s\S])*?Connect GitHub[\s\S]*?<\/section>/)?.[0]
    expect(github).toContain('aria-expanded="true"')
    expect(github).toContain('Account connected')
  })

  test('shows a restricted message for non-admins instead of the checklist', () => {
    const html = renderStatic(seededQueryClient(['agents:read']))

    expect(html).toContain('Onboarding is only visible to admins.')
    expect(html).not.toContain('/settings?section=providers')
  })

  test('never flashes the restricted-access message while permissions are still unresolved', () => {
    // No queryKeys.auth.permissions(...) seeded — the exact first-render shape
    // a brand-new admin's browser has right after PasskeyRegister navigates to
    // /onboarding. Regression: `isAdmin` used to collapse "unresolved" into
    // "confirmed non-admin", so this exact moment showed "Onboarding is only
    // visible to admins." to the admin who just registered.
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const html = renderStatic(queryClient)

    expect(html).not.toContain('Onboarding is only visible to admins.')
    expect(html).not.toContain('/settings?section=providers')
  })
})

describe('OnboardingPage — skip/unskip interactions', () => {
  let oldFetch: typeof globalThis.fetch
  let dom: Awaited<ReturnType<typeof acquireDomHarness>>
  let container: HTMLDivElement
  let root: ReturnType<typeof dom.createRoot>['root']
  const activeQueryClients = new Set<QueryClient>()
  let skipCalls: string[]
  let unskipCalls: string[]

  beforeEach(async () => {
    skipCalls = []
    unskipCalls = []
    oldFetch = globalThis.fetch
    dom = await acquireDomHarness({ url: 'http://localhost/' })
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      const skipMatch = /\/onboarding\/items\/([^/]+)\/skip$/.exec(url)
      if (skipMatch) {
        skipCalls.push(skipMatch[1])
        return Response.json(mixedStatus())
      }
      const unskipMatch = /\/onboarding\/items\/([^/]+)\/unskip$/.exec(url)
      if (unskipMatch) {
        unskipCalls.push(unskipMatch[1])
        return Response.json(mixedStatus())
      }
      if (url.endsWith('/squad-presets')) return Response.json([])
      if (url.endsWith('/squads')) return Response.json([])
      if (url.includes('/permissions')) return Response.json({ permissions: ['settings:read'] })
      if (url.includes('/onboarding/status')) {
        return Response.json(mixedStatus())
      }
      if (url.endsWith('/squads') || url.endsWith('/squad-presets')) return Response.json([])
      return Response.json({})
    }) as typeof fetch
    ;({ container, root } = dom.createRoot())
  })

  afterEach(async () => {
    await Promise.all([...activeQueryClients].map((client) => client.cancelQueries()))
    for (const client of activeQueryClients) client.clear()
    activeQueryClients.clear()
    await dom.cleanup()
    globalThis.fetch = oldFetch
  })

  test('one setup step is open at a time and a squad draft survives switching steps', async () => {
    const queryClient = seededQueryClient(['settings:read'], mixedStatus())
    activeQueryClients.add(queryClient)
    await dom.act(async () =>
      root.render(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={['/onboarding']}>
            <OnboardingPage />
          </MemoryRouter>
        </QueryClientProvider>
      )
    )
    const openSteps = () => container.querySelectorAll('[data-onboarding-step][aria-expanded="true"]')
    expect(openSteps()).toHaveLength(1)
    expect(openSteps()[0].textContent).toContain('Create your first squad')
    const input = container.querySelector<HTMLInputElement>('#first-squad-name')!
    await dom.act(async () => fireEvent.change(input, { target: { value: 'Research team' } }))
    await dom.act(async () => fireEvent.click(container.querySelector('[aria-controls="setup-step-github"]')!))
    expect(openSteps()).toHaveLength(1)
    expect(container.querySelector<HTMLElement>('#setup-step-first_squad')!.hidden).toBe(true)
    await dom.act(async () => fireEvent.click(container.querySelector('[aria-controls="setup-step-first_squad"]')!))
    expect(container.querySelector<HTMLInputElement>('#first-squad-name')!.value).toBe('Research team')
    expect(container.querySelector<HTMLElement>('#setup-step-voice_memory')!.hidden).toBe(true)
    expect(container.textContent).not.toContain('Save and enable')
  })

  test('skipping GitHub opens the squad step after the skip is saved', async () => {
    const status = mixedStatus()
    status.items.find((item) => item.id === 'github')!.state = 'todo'
    const queryClient = seededQueryClient(['settings:read'], status)
    activeQueryClients.add(queryClient)
    const saved = Promise.withResolvers<void>()
    const fetchStub = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/onboarding/items/github/skip')) {
        skipCalls.push('github')
        await saved.promise
        status.items.find((item) => item.id === 'github')!.state = 'skipped'
        return Response.json(status)
      }
      if (url.includes('/onboarding/status')) return Response.json(status)
      return fetchStub(input, init)
    }) as typeof fetch
    try {
      await dom.act(async () =>
        root.render(
          <QueryClientProvider client={queryClient}>
            <MemoryRouter initialEntries={['/onboarding']}>
              <OnboardingPage />
            </MemoryRouter>
          </QueryClientProvider>
        )
      )
      const github = container.querySelector<HTMLElement>('#setup-step-github')!
      const squad = container.querySelector<HTMLElement>('#setup-step-first_squad')!
      expect(github.hidden).toBe(false)
      expect(squad.hidden).toBe(true)
      await dom.act(async () => fireEvent.click(findButtonByText(container, 'Skip')))
      expect(skipCalls).toEqual(['github'])
      expect(github.hidden).toBe(false)
      await dom.act(async () => {
        saved.resolve()
        await waitFor(() => expect(squad.hidden).toBe(false))
      })
      expect(github.hidden).toBe(true)
      expect(container.querySelector('#first-squad-name')).not.toBeNull()
    } finally {
      saved.resolve()
    }
  })

  for (const delivery of ['email', 'link', 'failed'] as const) {
    test(`invites a teammate inline with ${delivery} delivery feedback`, async () => {
      const status = coreSettledStatus()
      const queryClient = seededQueryClient(['settings:read', 'users:create', 'users:read'], status)
      activeQueryClients.add(queryClient)
      const payloads: unknown[] = []
      let resent = false
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        if (url.endsWith('/permissions'))
          return Response.json({ permissions: ['settings:read', 'users:create', 'users:read'] })
        if (url.endsWith('/roles'))
          return Response.json([
            { id: 'operator', slug: 'operator', name: 'Operator', permissions: [], appliesTo: 'user' },
            { id: 'viewer', slug: 'viewer', name: 'Viewer', permissions: [], appliesTo: 'user' },
            { id: 'worker', slug: 'worker', name: 'Worker', permissions: [], appliesTo: 'agent' },
          ])
        if (url.endsWith('/users') && init?.method === 'POST') {
          payloads.push(JSON.parse(String(init.body)))
          return Response.json({
            id: 'invited',
            email: 'teammate@example.com',
            ...(delivery === 'link'
              ? { inviteUrl: 'https://tau.test/register?token=invitation' }
              : delivery === 'failed'
                ? { inviteEmailFailed: true }
                : {}),
          })
        }
        if (url.endsWith('/users') && init?.method !== 'POST') return Response.json([])
        if (url.endsWith('/users/invited/invite')) {
          resent = true
          return Response.json({ id: 'invited', email: 'teammate@example.com' })
        }
        if (url.endsWith('/onboarding/status')) return Response.json(status)
        if (url.endsWith('/squads') || url.endsWith('/squad-presets')) return Response.json([])
        return Response.json({})
      }) as typeof fetch
      await dom.act(async () =>
        root.render(
          <QueryClientProvider client={queryClient}>
            <MemoryRouter initialEntries={['/onboarding']}>
              <OnboardingPage />
            </MemoryRouter>
          </QueryClientProvider>
        )
      )
      await dom.act(async () => fireEvent.click(container.querySelector('[aria-controls="setup-step-invite_users"]')!))
      await dom.act(async () =>
        waitFor(() => expect(container.querySelector('#invite-user-role')?.textContent).toContain('Viewer'))
      )
      expect(container.querySelector('#invite-user-role')?.textContent).not.toContain('Worker')
      await dom.act(async () => {
        fireEvent.change(container.querySelector('#invite-user-email')!, { target: { value: 'teammate@example.com' } })
        fireEvent.change(container.querySelector('#invite-user-display-name')!, { target: { value: 'Teammate' } })
        fireEvent.change(container.querySelector('#invite-user-role')!, { target: { value: 'viewer' } })
      })
      await dom.act(async () => fireEvent.submit(container.querySelector('#setup-step-invite_users form')!))
      await dom.act(async () =>
        waitFor(() => expect(container.querySelector('#setup-step-invite_users [role="status"]')).not.toBeNull())
      )
      expect(payloads).toEqual([{ email: 'teammate@example.com', displayName: 'Teammate', roleIds: ['viewer'] }])
      expect(container.querySelector('a[href*="section=users"]')).toBeNull()
      if (delivery === 'link') {
        expect(container.textContent).toContain('Copy link')
        expect(container.textContent).not.toContain('Invitation sent to')
      } else if (delivery === 'failed') {
        expect(container.textContent).toContain('invitation email could not be sent')
        await dom.act(async () => fireEvent.click(findButtonByText(container, 'Resend invitation')))
        await dom.act(async () =>
          waitFor(() => expect(container.textContent).toContain('Invitation sent to teammate@example.com.'))
        )
        expect(resent).toBe(true)
      } else expect(container.textContent).toContain('Invitation sent to teammate@example.com.')
    })
  }

  test('keeps multiple invitations and copies each link after closing and reopening optional setup', async () => {
    const status = coreSettledStatus()
    const permissions = ['settings:read', 'users:read', 'users:create']
    const queryClient = seededQueryClient(permissions, status)
    activeQueryClients.add(queryClient)
    const member = (id: string, hasPasskey = false) => ({
      id,
      email: `${id}@example.com`,
      displayName: null,
      disabledAt: null,
      hasPasskey,
      passkeyCount: hasPasskey ? 1 : 0,
      inviteExpiresAt: null,
    })
    const users = [member('admin', true), member('existing')]
    const generated: string[] = []
    const copied: string[] = []
    const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (value: string) => {
          copied.push(value)
        },
      },
    })
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/permissions')) return Response.json({ permissions })
      if (url.endsWith('/onboarding/status')) return Response.json(status)
      if (url.endsWith('/roles'))
        return Response.json([
          { id: 'operator', slug: 'operator', name: 'Operator', permissions: [], appliesTo: 'user' },
        ])
      if (url.endsWith('/users') && init?.method === 'POST') {
        const { email } = JSON.parse(String(init.body))
        const user = member(email.split('@')[0])
        users.push(user)
        return Response.json({ ...user, inviteUrl: `https://tau.test/register?token=${user.id}` })
      }
      if (url.endsWith('/users')) return Response.json(users)
      if (url.endsWith('/users/existing/invite?delivery=link')) {
        generated.push('existing')
        return Response.json({ ...users[1], inviteUrl: 'https://tau.test/register?token=existing-new' })
      }
      if (url.endsWith('/squads') || url.endsWith('/squad-presets')) return Response.json([])
      return Response.json({})
    }) as typeof fetch
    try {
      await dom.act(async () =>
        root.render(
          <QueryClientProvider client={queryClient}>
            <MemoryRouter>
              <OnboardingPage />
            </MemoryRouter>
          </QueryClientProvider>
        )
      )
      const toggle = container.querySelector('[aria-controls="setup-step-invite_users"]')!
      await dom.act(async () => fireEvent.click(toggle))
      await dom.act(async () =>
        waitFor(() => expect(container.querySelector('[data-team-member="existing"]')).not.toBeNull())
      )
      expect(container.querySelector('[data-team-member="admin"]')!.textContent).toContain('Joined')
      expect(container.querySelector('[data-team-member="admin"] button')).toBeNull()
      for (const id of ['first', 'second']) {
        await dom.act(async () =>
          fireEvent.change(container.querySelector('#invite-user-email')!, { target: { value: `${id}@example.com` } })
        )
        await dom.act(async () => fireEvent.submit(container.querySelector('#setup-step-invite_users form')!))
        await dom.act(async () =>
          waitFor(() => expect(container.querySelector(`[data-team-member="${id}"]`)).not.toBeNull())
        )
        expect(container.querySelector<HTMLInputElement>('#invite-user-email')!.value).toBe('')
      }
      await dom.act(async () => fireEvent.click(toggle))
      await dom.act(async () => fireEvent.click(toggle))
      for (const id of ['first', 'second']) {
        await dom.act(async () =>
          fireEvent.click(container.querySelector(`[aria-label="Copy invite link for ${id}@example.com"]`)!)
        )
      }
      await dom.act(async () =>
        fireEvent.click(container.querySelector('[aria-label="Create invite link for existing@example.com"]')!)
      )
      await dom.act(async () =>
        waitFor(() =>
          expect(container.querySelector('[aria-label="Copy invite link for existing@example.com"]')).not.toBeNull()
        )
      )
      await dom.act(async () =>
        fireEvent.click(container.querySelector('[aria-label="Copy invite link for existing@example.com"]')!)
      )
      expect(copied).toEqual([
        'https://tau.test/register?token=first',
        'https://tau.test/register?token=second',
        'https://tau.test/register?token=existing-new',
      ])
      expect(generated).toEqual(['existing'])
      expect(container.querySelectorAll('[data-team-member]')).toHaveLength(4)
      expect(container.querySelector('[data-optional-setup]')!.textContent).not.toMatch(/Skip|Unskip|Continue|Done/)
      expect(skipCalls).toEqual([])
    } finally {
      if (originalClipboard) Object.defineProperty(navigator, 'clipboard', originalClipboard)
      else Reflect.deleteProperty(navigator, 'clipboard')
    }
  })

  test('configures a chat integration inline without adding a checklist item', async () => {
    const status = coreSettledStatus()
    const permissions = ['settings:read', 'integrations:read:*', 'integrations:write:*']
    const queryClient = seededQueryClient(permissions, status)
    activeQueryClients.add(queryClient)
    const entry = { key: 'discord', label: 'Discord', enabled: false, description: 'Chat with agents.' }
    const config = {
      fields: [
        {
          key: 'DISCORD_BOT_TOKEN',
          label: 'Bot token',
          secret: true,
          required: true,
          configured: false,
          placeholder: 'Bot token',
        },
      ],
    }
    let credentials: unknown
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/permissions')) return Response.json({ permissions })
      if (url.endsWith('/onboarding/status')) return Response.json(status)
      if (url.endsWith('/integrations/catalog'))
        return Response.json({
          integrations: [
            entry,
            { key: 'slack', label: 'Slack', enabled: false },
            { key: 'telegram', label: 'Telegram', enabled: false },
          ],
        })
      if (url.endsWith('/integrations/providers/discord/enabled')) {
        entry.enabled = JSON.parse(String(init?.body)).enabled
        return Response.json({ enabled: entry.enabled })
      }
      if (url.endsWith('/integrations/providers/discord/channel-settings')) {
        if (init?.method === 'PUT') credentials = JSON.parse(String(init.body))
        return Response.json(config)
      }
      if (url.endsWith('/squads') || url.endsWith('/squad-presets')) return Response.json([])
      return Response.json({})
    }) as typeof fetch
    await dom.act(async () =>
      root.render(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter>
            <OnboardingPage />
          </MemoryRouter>
        </QueryClientProvider>
      )
    )
    await dom.act(async () => fireEvent.click(container.querySelector('[aria-controls="setup-step-chat_channel"]')!))
    await dom.act(async () =>
      waitFor(() => expect(container.querySelector('[aria-label="Enable Discord globally"]')).not.toBeNull())
    )
    expect(container.querySelector('[aria-label="Enable Slack globally"]')).not.toBeNull()
    expect(container.querySelector('[aria-label="Enable Telegram globally"]')).not.toBeNull()
    expect(container.querySelector('[aria-label="Chat platform"]')).toBeNull()
    await dom.act(async () => fireEvent.click(container.querySelector('[aria-label="Enable Discord globally"]')!))
    await dom.act(async () =>
      waitFor(() => expect(container.querySelector('input[placeholder="Bot token"]')).not.toBeNull())
    )
    await dom.act(async () =>
      fireEvent.change(container.querySelector('input[placeholder="Bot token"]')!, {
        target: { value: 'test-bot-token' },
      })
    )
    await dom.act(async () => fireEvent.submit(container.querySelector('#setup-step-chat_channel form')!))
    await dom.act(async () => waitFor(() => expect(credentials).toEqual({ DISCORD_BOT_TOKEN: 'test-bot-token' })))
    expect(entry.enabled).toBe(true)
    expect(container.querySelector('a[href*="section=integrations"]')).toBeNull()
    expect(container.querySelector('[data-optional-setup]')!.textContent).not.toMatch(/Skip|Unskip|Continue/)
  })

  test('clicking Skip on GitHub calls the skip API and invalidates the onboarding query', async () => {
    const status = coreSettledStatus()
    status.items.find((item) => item.id === 'github')!.state = 'todo'
    const queryClient = seededQueryClient(['settings:read'], status)
    activeQueryClients.add(queryClient)
    const invalidated: unknown[] = []
    const originalInvalidate = queryClient.invalidateQueries.bind(queryClient)
    queryClient.invalidateQueries = ((...args: Parameters<typeof originalInvalidate>) => {
      invalidated.push(args[0])
      return originalInvalidate(...args)
    }) as typeof queryClient.invalidateQueries

    await dom.act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={['/onboarding']}>
            <OnboardingPage />
          </MemoryRouter>
        </QueryClientProvider>
      )
    })

    const skipButton = findButtonByText(container, 'Skip')
    await dom.act(async () => {
      skipButton.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    // Flush the mutation's async resolution (mutationFn + onSuccess) so the
    // resulting state update lands inside act().
    await dom.act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(skipCalls.length).toBe(1)
    // Assert the invalidated key IS the onboarding key — not merely that some
    // invalidation happened, which would also pass if the mutation invalidated
    // an unrelated query by mistake.
    expect(invalidated).toContainEqual({ queryKey: onboardingQueryKeys.all })
  })

  test('clicking Unskip on a skipped item calls the unskip API', async () => {
    const queryClient = seededQueryClient(['settings:read'], mixedStatus())
    activeQueryClients.add(queryClient)

    await dom.act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={['/onboarding']}>
            <OnboardingPage />
          </MemoryRouter>
        </QueryClientProvider>
      )
    })

    const unskipButton = findButtonByText(container, 'Unskip')
    await dom.act(async () => {
      unskipButton.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await dom.act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(unskipCalls.length).toBe(1)
    expect(skipCalls.length).toBe(0)
  })

  function findButtonByText(element: Element, text: string): HTMLButtonElement {
    const buttons: HTMLButtonElement[] = []
    const walk = (el: Element) => {
      for (const child of Array.from(el.children)) {
        if (child.tagName.toLowerCase() === 'button' && child.textContent === text) {
          buttons.push(child as HTMLButtonElement)
        }
        walk(child)
      }
    }
    walk(element)
    if (buttons.length === 0) throw new Error(`No button found with text: ${text}`)
    return buttons[0]
  }
})

describe('OnboardingPage — appearance control', () => {
  let oldFetch: typeof globalThis.fetch
  let dom: Awaited<ReturnType<typeof acquireDomHarness>>
  let container: HTMLDivElement
  let root: ReturnType<typeof dom.createRoot>['root']
  let queryClient: QueryClient

  beforeEach(async () => {
    oldFetch = globalThis.fetch
    dom = await acquireDomHarness({ url: 'http://localhost/onboarding' })
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.includes('/permissions')) return Response.json({ permissions: ['settings:read'] })
      if (url.includes('/onboarding/status')) return Response.json(mixedStatus())
      if (url.endsWith('/squads') || url.endsWith('/squad-presets')) return Response.json([])
      return Response.json({})
    }) as typeof fetch
    ;({ container, root } = dom.createRoot())
  })

  afterEach(async () => {
    await queryClient?.cancelQueries()
    queryClient?.clear()
    delete window.tauDesktopApp
    document.documentElement.classList.remove('dark')
    await dom.cleanup()
    globalThis.fetch = oldFetch
  })

  async function render() {
    const { ThemeProvider } = await import('../../providers/ThemeProvider')
    queryClient = seededQueryClient(['settings:read'], mixedStatus())
    await dom.act(async () =>
      root.render(
        <ThemeProvider>
          <QueryClientProvider client={queryClient}>
            <MemoryRouter initialEntries={['/onboarding']}>
              <OnboardingPage />
            </MemoryRouter>
          </QueryClientProvider>
        </ThemeProvider>
      )
    )
  }

  const option = (label: string) =>
    [...container.querySelectorAll<HTMLInputElement>('[role="radiogroup"][aria-label="Appearance"] input')].find(
      (input) => input.parentElement?.textContent === label
    )!

  test('switching to Dark applies and remembers the theme; System follows the OS', async () => {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: (query: string) => ({ matches: query === '(prefers-color-scheme: dark)', media: query }),
    })
    await render()
    // A browser with no stored choice keeps the light default.
    expect(option('Light').checked).toBe(true)
    expect(document.documentElement.classList.contains('dark')).toBe(false)

    await dom.act(async () => fireEvent.click(option('Dark')))
    expect(option('Dark').checked).toBe(true)
    expect(document.documentElement.classList.contains('dark')).toBe(true)
    expect(localStorage.getItem('ficus-appearance')).toBe('dark')

    await dom.act(async () => fireEvent.click(option('Light')))
    expect(document.documentElement.classList.contains('dark')).toBe(false)

    await dom.act(async () => fireEvent.click(option('System')))
    expect(localStorage.getItem('ficus-appearance')).toBe('system')
    expect(document.documentElement.classList.contains('dark')).toBe(true)
  })

  test('inside Tau Desktop with no stored choice, System is selected and follows the OS', async () => {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: (query: string) => ({ matches: query === '(prefers-color-scheme: dark)', media: query }),
    })
    window.tauDesktopApp = { version: 1, notificationsEnabled: async () => false, deliverNotifications: async () => {} }
    await render()

    expect(option('System').checked).toBe(true)
    expect(document.documentElement.classList.contains('dark')).toBe(true)
  })
})
