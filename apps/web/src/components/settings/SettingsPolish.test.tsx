import { afterEach, beforeEach, expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, waitFor } from '@testing-library/dom'
import { MemoryRouter } from 'react-router-dom'
import type { ReactNode } from 'react'
import { acquireDomHarness } from '../../test/domHarness'
import { PermissionsProvider } from '../../hooks/usePermissions'
import { queryKeys, integrationQueryKeys } from '../../queryKeys'
import { SquadPresetsSection } from './SquadPresetsSection'
import { SkillsSection } from './SkillsSection'
import { NotificationsConfigSection } from './NotificationsConfigSection'
import { AssistantMemorySection } from './AssistantMemorySection'
import { ProviderAuthSection } from './ProviderAuthSection'

let dom: Awaited<ReturnType<typeof acquireDomHarness>>
let client: QueryClient
let oldFetch: typeof fetch
beforeEach(async () => {
  dom = await acquireDomHarness({ url: 'http://localhost/settings' })
  client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } })
  oldFetch = globalThis.fetch
})
afterEach(async () => {
  globalThis.fetch = oldFetch
  client.clear()
  await dom.cleanup()
})
async function render(node: ReactNode, writable = true) {
  const { root, container } = dom.createRoot()
  await dom.act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <PermissionsProvider
          usePermissions={() => ({
            permissions: [],
            can: (permission) => writable || !/write|update|create|delete/.test(permission),
            isLoading: false,
            isError: false,
          })}
        >
          <MemoryRouter>{node}</MemoryRouter>
        </PermissionsProvider>
      </QueryClientProvider>
    )
  )
  return container
}
const template = { disabled: false, yamlFieldOverrides: [], hasTemplate: false }

test('squad preset search opens an editable modal and leaves the directory in place', async () => {
  client.setQueryData(queryKeys.squadPresets.list(), [
    {
      ...template,
      id: 'research',
      name: 'Research',
      description: 'Investigate topics',
      defaultAgents: [],
      scheduleTemplates: [],
    },
    {
      ...template,
      id: 'engineering',
      name: 'Engineering',
      description: 'Build apps',
      defaultAgents: [],
      scheduleTemplates: [],
    },
  ])
  client.setQueryData(queryKeys.agentTypes.list(), [])
  const page = await render(<SquadPresetsSection />)
  await dom.act(async () =>
    fireEvent.change(page.querySelector('[aria-label="Search squad presets"]')!, { target: { value: 'investigate' } })
  )
  expect(page.textContent).not.toContain('Engineering')
  await dom.act(async () => fireEvent.click(page.querySelector('[aria-label="Edit Research"]')!))
  const dialog = document.querySelector('[role="dialog"]')!
  expect(dialog.getAttribute('aria-label')).toBe('Edit Research')
  expect(dialog.querySelector('[aria-label="Name"]')).not.toBeNull()
  expect(page.querySelector('[aria-label="Search squad presets"]')).not.toBeNull()
  await dom.act(async () => fireEvent.keyDown(dialog.querySelector('input')!, { key: 'Escape' }))
  expect(document.querySelector('[aria-label="Edit Research"][role="dialog"]')).toBeNull()
})

test('skills keeps import and editing out of the list, with search and support files in the modal', async () => {
  client.setQueryData(queryKeys.skills.list(), [
    {
      ...template,
      id: 'research',
      name: 'Research',
      description: 'Investigate topics',
      content: '# Research',
      supportFiles: {},
    },
  ])
  const page = await render(<SkillsSection />)
  expect(page.querySelector('textarea')).toBeNull()
  await dom.act(async () =>
    fireEvent.click([...page.querySelectorAll('button')].find((b) => b.textContent === 'Edit')!)
  )
  const dialog = document.querySelector('[role="dialog"]')!
  expect(dialog.getAttribute('aria-label')).toBe('Edit Research')
  expect(dialog.textContent).toContain('Support files')
  expect(page.querySelector('textarea')).toBeNull()
})

test('notification destination edits preserve rule order, IDs and matching conditions', async () => {
  const rules = [
    { id: 'operator-alert', event: 'inbox.messageReceived', match: { source: 'fleet-alert' }, channels: ['push'] },
    { event: 'inbox.messageReceived', match: { recipientType: ['user', 'system'] }, channels: ['push'] },
  ]
  client.setQueryData(queryKeys.notificationConfig.detail(), {
    ...template,
    rules,
    channels: { push: { enabled: true }, slack: { enabled: true } },
  })
  let saved: any
  globalThis.fetch = (async (_input, init) => {
    saved = JSON.parse(String(init?.body))
    return Response.json({ ok: true })
  }) as typeof fetch
  const page = await render(<NotificationsConfigSection />)
  expect(page.textContent).toContain('The fleet needs attention')
  expect(page.querySelector('details')?.open).toBe(false)
  await dom.act(async () => fireEvent.click(page.querySelector('[aria-label="The fleet needs attention: Slack"]')!))
  await dom.act(async () =>
    fireEvent.click([...page.querySelectorAll('button')].find((b) => b.textContent === 'Save changes')!)
  )
  await waitFor(() => expect(saved?.rules).toEqual([{ ...rules[0], channels: ['push', 'slack'] }, rules[1]]))
})

test('assistant features show pending setup and an inline API key form without enabling anything on render', async () => {
  client.setQueryData(queryKeys.settings.list(), [
    { key: 'EMBEDDINGS_ENABLED', value: 'true' },
    { key: 'ASSISTANT_REALTIME_ENABLED', value: 'true' },
    { key: 'TRANSCRIPTION_ENABLED', value: 'true' },
  ])
  client.setQueryData(integrationQueryKeys.catalog(), {
    integrations: [
      { key: 'openai-services', enabled: false, setup: { state: 'needs_setup', issues: ['API key required'] } },
    ],
  })
  client.setQueryData(integrationQueryKeys.serviceSettings('openai-services'), {
    fields: [{ key: 'OPENAI_API_KEY', label: 'API key', required: true, secret: true, configured: false }],
  })
  const requests: string[] = []
  globalThis.fetch = (async (_input, init) => {
    requests.push(init?.method ?? 'GET')
    return Response.json({})
  }) as typeof fetch
  const page = await render(<AssistantMemorySection onboarding />)
  expect(page.textContent).toContain('Make Ficus your own')
  expect(page.textContent).toContain('Needs OpenAI API setup')
  expect(page.querySelector('input[type="password"]')?.hasAttribute('required')).toBe(true)
  expect(page.querySelectorAll('[role="switch"]:checked')).toHaveLength(3)
  expect(page.textContent).toContain('Voice dictation')
  expect(requests).toEqual([])
})

test('provider directory groups accounts separately and puts common disconnected providers first', async () => {
  client.setQueryData(queryKeys.providerAuth.list(), [
    { provider: 'groq', hasCredential: true, configured: true, disabled: true },
  ])
  client.setQueryData(queryKeys.providerAuth.oauthProviders(), [])
  client.setQueryData(
    queryKeys.providerAuth.catalog(),
    ['groq', 'z-ai', 'deepseek', 'xai', 'aardvark'].map((id) => ({ id, label: id, modelCount: 1 }))
  )
  client.setQueryData(queryKeys.providerAuth.openRouterRouting(), {
    enabled: false,
    active: false,
    configured: false,
    tiers: [],
    vendors: [],
    health: 'available',
  })
  const page = await render(<ProviderAuthSection />)
  expect(page.querySelector('[aria-label="Connected providers"]')?.textContent).toContain('groq')
  const cards = [...page.querySelectorAll('[aria-label="Disconnected providers"] article')].map(
    (card) => card.querySelector('h4')?.textContent
  )
  expect(cards.slice(0, 3)).toEqual(['OpenAI', 'Anthropic', 'OpenRouter'])
  expect(cards.indexOf('aardvark')).toBeGreaterThan(cards.indexOf('deepseek'))
})
