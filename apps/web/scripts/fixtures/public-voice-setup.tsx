/** Synthetic Settings/onboarding fixture. All data and mutations stay in memory. */
import React from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router'
import { permissionMatches, type PublicVoiceProfileJson, type Squad } from '@ficus/shared'
import { SettingsPage } from '../../src/components/SettingsPage'
import { OnboardingPage } from '../../src/components/onboarding/OnboardingPage'
import { PermissionsProvider } from '../../src/hooks/usePermissions'
import { integrationQueries, queries } from '../../src/queryOptions'
import { onboardingQueryKeys } from '../../src/queryKeys'
import { applyResolvedTheme } from '../../src/theme/apply'
import { FICUS_THEME } from '../../src/theme/registry'
import '../../src/index.css'

applyResolvedTheme(document.documentElement, FICUS_THEME, 'light')
const onboarding = new URLSearchParams(location.search).has('onboarding')
let failDefault = new URLSearchParams(location.search).has('partial')
const now = '2026-11-19T12:00:00Z'
const base =
  'Lead with the result. Use complete sentences and explain the next step. Keep public updates concise and specific.'
const profile = (id: string, name: string, over: Partial<PublicVoiceProfileJson> = {}): PublicVoiceProfileJson => ({
  id,
  name,
  description: 'Clear, direct public updates for the team.',
  base,
  surfaces: {},
  disabled: false,
  hasTemplate: false,
  yamlFieldOverrides: [],
  bytes: 124,
  assignedSquadCount: 0,
  createdAt: now,
  updatedAt: now,
  ...over,
})
let profiles = [
  profile('default', 'Ficus default', { hasTemplate: true, isInstanceDefault: true }),
  profile('platform', 'Platform voice', { assignedSquadCount: 2, isInstanceDefault: false }),
  profile('previous', 'Previous launch voice', { disabled: true, isInstanceDefault: false }),
]
let squads = [
  { id: 'platform-squad', name: 'Platform engineering', publicVoiceId: 'platform' },
  { id: 'checkout-squad', name: 'Checkout experience', publicVoiceId: 'platform' },
  {
    id: 'docs-squad',
    name: 'Developer documentation',
    publicVoiceId: null,
    publicVoice: { base: 'Our own voice.', surfaces: {} },
  },
  { id: 'readonly-squad', name: 'Security reviews', publicVoiceId: null },
].map((s) => ({
  ...s,
  purpose: 'Synthetic visual fixture',
  createdAt: now,
  updatedAt: now,
  status: 'active',
})) as Squad[]
const accounts = [
  { id: 'a1111111-1111-4111-8111-111111111111', login: 'octocat', displayName: 'Personal GitHub account' },
]
const result = {
  login: 'octocat',
  draft: { base, surfaces: { commits: { mode: 'add', text: 'Use short, specific commit subjects.' } } },
  observations: ['Lead with the answer.', 'Explain the next step in complete sentences.'],
  exemplars: [],
  sampling: {
    filters: {},
    counts: {
      collected: 30,
      kept: 20,
      droppedByFilter: { date: 0, repository: 0 },
      droppedAsToolAuthored: 4,
      droppedAsTemplate: 6,
    },
    dateRange: {},
    publicRepositories: ['example/library'],
    privateRepositories: [],
    pagingCapped: false,
  },
  bytes: 175,
  maxBytes: 2000,
}
const client = new QueryClient({
  defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } },
})
const status = {
  ready: true,
  items: [
    { id: 'ai_provider', required: true, state: 'done' },
    { id: 'github', required: false, state: 'done' },
    { id: 'first_squad', required: true, state: 'done' },
  ],
}
client.setQueryData(queries.publicVoices.list().queryKey, profiles)
client.setQueryData(queries.publicVoices.githubAccounts().queryKey, accounts)
client.setQueryData(queries.squads.list().queryKey, squads)
client.setQueryData(integrationQueries.catalog().queryKey, { integrations: [] })
client.setQueryData(onboardingQueryKeys.status(), status)
window.fetch = (async (input, init) => {
  const path = new URL(String(input), location.origin).pathname
  const method = init?.method ?? 'GET'
  if (path === '/api/public-voices/derive/github-accounts') return Response.json(accounts)
  if (path === '/api/public-voices/derive' && method === 'POST') return Response.json(result)
  if (path === '/api/public-voices') {
    if (method === 'GET') return Response.json(profiles)
    if (method === 'POST') {
      const data = JSON.parse(String(init?.body))
      if (profiles.some((p) => p.id === data.id))
        return Response.json({ error: `Voice profile "${data.id}" already exists` }, { status: 409 })
      const created = profile(data.id, data.name, { ...data, isInstanceDefault: false })
      profiles.push(created)
      return Response.json(created, { status: 201 })
    }
  }
  // The squads on the instance default, as the server counts them: no custom base, no usable assignment.
  const squadCount = () =>
    squads.filter(
      (s) =>
        !s.publicVoice?.base?.trim() &&
        (!s.publicVoiceId || profiles.find((p) => p.id === s.publicVoiceId)?.disabled !== false)
    ).length
  if (path === '/api/public-voices/settings/instance-default' && method === 'GET') {
    const chosen = profiles.find((p) => p.isInstanceDefault) ?? profiles[0]!
    return Response.json({
      voiceId: chosen.id,
      name: chosen.name,
      effectiveVoiceId: chosen.id,
      effectiveName: chosen.name,
      fallback: null,
      squadCount: squadCount(),
    })
  }
  if (path === '/api/public-voices/settings/instance-default' && method === 'PUT') {
    if (failDefault) {
      failDefault = false
      return Response.json({ error: 'Forbidden' }, { status: 403 })
    }
    const { voiceId } = JSON.parse(String(init?.body))
    profiles = profiles.map((p) => ({ ...p, isInstanceDefault: p.id === voiceId }))
    const chosen = profiles.find((p) => p.id === voiceId)!
    return Response.json({
      voiceId,
      name: chosen.name,
      effectiveVoiceId: voiceId,
      effectiveName: chosen.name,
      fallback: null,
      squadCount: squadCount(),
      overCapSquadCount: 0,
    })
  }
  if (path === '/api/squads' && method === 'GET') return Response.json(squads)
  if (path.startsWith('/api/squads/') && path.endsWith('/voice') && method === 'PATCH') {
    const id = path.split('/')[3]
    const { voiceId } = JSON.parse(String(init?.body))
    squads = squads.map((s) => (s.id === id ? { ...s, publicVoiceId: voiceId } : s))
    return Response.json({ voiceId })
  }
  if (path === '/api/onboarding/status') return Response.json(status)
  if (path === '/api/integrations/catalog') return Response.json({ integrations: [] })
  throw new Error(`Unexpected fixture request: ${method} ${path}`)
}) as typeof fetch
createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={client}>
    <PermissionsProvider
      usePermissions={(squadId) => {
        const permissions = squadId
          ? squadId === 'readonly-squad'
            ? ['squads:read']
            : ['squads:read', 'squads:update']
          : ['settings:read', 'agent-types:read', 'agent-types:update', 'integrations:use']
        return {
          permissions,
          can: (requested) => permissions.some((held) => permissionMatches(held, requested)),
          isLoading: false,
          isError: false,
          identity: { type: 'user', userId: 'synthetic-person' },
        }
      }}
    >
      <MemoryRouter initialEntries={[onboarding ? '/onboarding' : '/settings?section=voices']}>
        <main style={{ height: '100%', overflow: 'auto', padding: 16 }}>
          <div style={{ maxWidth: 1200, margin: '0 auto', height: '100%' }}>
            {onboarding ? <OnboardingPage /> : <SettingsPage />}
          </div>
        </main>
      </MemoryRouter>
    </PermissionsProvider>
  </QueryClientProvider>
)
