import { afterEach, expect, mock, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { SettingMetadata } from '../../api/settings'
import { PermissionsProvider } from '../../hooks/usePermissions'
import { queries } from '../../queryOptions'
import { queryKeys } from '../../queryKeys'
import { acquireDomHarness } from '../../test/domHarness'
import { SettingsApiProvider } from './settingsApi'
import { STREAM_SUMMARIES_SETTING, StreamSummariesSetting } from './StreamSummariesSetting'
import { WorkFeaturesSection } from './WorkFeaturesSection'
import { modelTierQueryKeys } from '../../queryKeys'
import { isSectionAllowed, SECTION_GROUPS } from './settingsSections'
import { SETTINGS_SEARCH_ENTRIES } from './settingsSearch'

let dom: Awaited<ReturnType<typeof acquireDomHarness>> | undefined
afterEach(async () => {
  await dom?.cleanup()
  dom = undefined
})

const setting = (value: string): SettingMetadata => ({
  key: STREAM_SUMMARIES_SETTING,
  value,
  type: 'boolean',
  default: 'true',
  description: 'Write one-line work stream summaries.',
  isDefault: value === 'true',
  updatedAt: null,
  updatedBy: null,
})

async function renderSetting(
  value: string,
  permissions: string[] = ['settings:read', 'settings:write'],
  usableCandidates?: string[]
) {
  // The server keeps what was saved, so refreshing the settings after a save reads it back.
  let stored = value
  dom = await acquireDomHarness({ url: 'http://localhost/', api: { '/api/settings': () => [setting(stored)] } })
  const { root, container } = dom.createRoot()
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(queries.settings.list().queryKey, [setting(value)])
  client.setQueryData(queryKeys.squads.activeWorkStreams('squad-1'), [])
  client.setQueryData(queryKeys.activity.presence(), {})
  client.setQueryData(queryKeys.agents.detail('agent-1'), { id: 'agent-1' })
  const setSetting = mock((_key: string, next: string) => {
    stored = next
    return Promise.resolve()
  })
  await dom.act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <PermissionsProvider
          usePermissions={() => ({
            can: (permission: string) => permissions.includes(permission),
            permissions,
            isLoading: false,
            isError: false,
          })}
        >
          <SettingsApiProvider api={{ setSetting }}>
            <StreamSummariesSetting usableCandidates={usableCandidates} />
          </SettingsApiProvider>
        </PermissionsProvider>
      </QueryClientProvider>
    )
  )
  const toggle = () => container.querySelector<HTMLInputElement>('input[role="switch"]')!
  return { container, toggle, setSetting, client }
}

const NO_MODEL = 'No Lite model is signed in'

test('shows the switch on, and turning it off saves the setting and refreshes work lists and Active work', async () => {
  const { container, toggle, setSetting, client } = await renderSetting('true')
  expect(container.textContent).toContain('Work stream summaries')
  expect(toggle().checked).toBe(true)
  await dom!.act(async () => toggle().click())
  expect(setSetting.mock.calls).toEqual([[STREAM_SUMMARIES_SETTING, 'false']])
  // Saved summaries are left out while the switch is off, so stream rows and cards are refetched.
  expect(client.getQueryState(queryKeys.squads.activeWorkStreams('squad-1'))?.isInvalidated).toBe(true)
  expect(client.getQueryState(queryKeys.activity.presence())?.isInvalidated).toBe(true)
  expect(client.getQueryState(queryKeys.agents.detail('agent-1'))?.isInvalidated).toBe(false)
})

test('says no Lite model is signed in beside a switched-on setting, without changing it', async () => {
  const { container, toggle, setSetting } = await renderSetting('true', undefined, [])
  expect(toggle().checked).toBe(true)
  expect(container.textContent).toContain(NO_MODEL)
  expect(setSetting).not.toHaveBeenCalled()
})

test('is read-only without settings:write', async () => {
  const { toggle } = await renderSetting('false', ['settings:read'])
  expect(toggle().checked).toBe(false)
  expect(toggle().disabled).toBe(true)
})

test('lives on the Features page, which warns when no Lite model is signed in', async () => {
  dom = await acquireDomHarness({ url: 'http://localhost/' })
  const { root, container } = dom.createRoot()
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(queries.settings.list().queryKey, [setting('true')])
  client.setQueryData(modelTierQueryKeys.list(), [{ slug: 'lite', usableCandidates: [] }])
  const permissions = ['settings:read', 'settings:write', 'agent-types:read']
  await dom.act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <PermissionsProvider
          usePermissions={() => ({
            can: (permission: string) => permissions.includes(permission),
            permissions,
            isLoading: false,
            isError: false,
          })}
        >
          <SettingsApiProvider api={{ setSetting: () => Promise.resolve() }}>
            <WorkFeaturesSection />
          </SettingsApiProvider>
        </PermissionsProvider>
      </QueryClientProvider>
    )
  )
  expect(container.querySelector('h2')?.textContent).toBe('Features')
  expect(container.querySelector('[data-setting-target="stream-summaries"]')).not.toBeNull()
  expect(container.textContent).toContain(NO_MODEL)
  // The page is Features, last in the Work group, under the unchanged work-features id.
  const work = SECTION_GROUPS.find((group) => group.label === 'Work')?.items ?? []
  expect(work.map((item) => item.label)).toEqual([
    'Workflows',
    'Agents',
    'Voices',
    'Skills',
    'Integrations',
    'Features',
  ])
  expect(work.at(-1)?.id).toBe('work-features')
  // Settings search lands on the switch, and the page needs settings:read.
  expect(SETTINGS_SEARCH_ENTRIES).toContainEqual(
    expect.objectContaining({ section: 'work-features', id: 'stream-summaries' })
  )
  expect(isSectionAllowed('work-features', (permission) => permission === 'settings:read', false)).toBe(true)
  expect(isSectionAllowed('work-features', () => false, false)).toBe(false)
})
