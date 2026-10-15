import { afterEach, expect, mock, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { SettingMetadata } from '../../api/settings'
import { PermissionsProvider } from '../../hooks/usePermissions'
import { queries } from '../../queryOptions'
import { queryKeys } from '../../queryKeys'
import { acquireDomHarness } from '../../test/domHarness'
import { SettingsApiProvider } from './settingsApi'
import { REPLY_SUGGESTIONS_SETTING, ReplySuggestionsSetting } from './ReplySuggestionsSetting'

let dom: Awaited<ReturnType<typeof acquireDomHarness>> | undefined
afterEach(async () => {
  await dom?.cleanup()
  dom = undefined
})

const setting = (value: string): SettingMetadata => ({
  key: REPLY_SUGGESTIONS_SETTING,
  value,
  type: 'boolean',
  default: 'true',
  description: 'Suggest one-tap replies.',
  isDefault: value === 'true',
  updatedAt: null,
  updatedBy: null,
})

async function renderSetting(
  value: string,
  permissions: string[] = ['settings:read', 'settings:write'],
  usableCandidates?: string[]
) {
  dom = await acquireDomHarness({ url: 'http://localhost/' })
  const { root, container } = dom.createRoot()
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(queries.settings.list().queryKey, [setting(value)])
  client.setQueryData(queryKeys.agents.messages('agent-1'), { messages: [] })
  client.setQueryData(queryKeys.agents.detail('agent-1'), { id: 'agent-1' })
  const setSetting = mock((_key: string, _value: string) => Promise.resolve())
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
            <ReplySuggestionsSetting usableCandidates={usableCandidates} />
          </SettingsApiProvider>
        </PermissionsProvider>
      </QueryClientProvider>
    )
  )
  const toggle = () => container.querySelector<HTMLInputElement>('input[role="switch"]')!
  return { container, toggle, setSetting, client }
}

const NO_MODEL = 'No Lite model is signed in'

test('shows the switch on, and turning it off saves the setting and refreshes chat messages', async () => {
  const { container, toggle, setSetting, client } = await renderSetting('true')
  expect(container.textContent).toContain('Reply suggestions')
  expect(toggle().checked).toBe(true)
  await dom!.act(async () => toggle().click())
  expect(setSetting.mock.calls).toEqual([[REPLY_SUGGESTIONS_SETTING, 'false']])
  // Saved chips are left out while the switch is off, so cached chat messages are refetched.
  expect(client.getQueryState(queryKeys.agents.messages('agent-1'))?.isInvalidated).toBe(true)
  expect(client.getQueryState(queryKeys.agents.detail('agent-1'))?.isInvalidated).toBe(false)
})

test('says no Lite model is signed in beside a switched-on setting, without changing it', async () => {
  const { container, toggle, setSetting } = await renderSetting('true', undefined, [])
  expect(toggle().checked).toBe(true)
  expect(container.textContent).toContain(NO_MODEL)
  expect(setSetting).not.toHaveBeenCalled()
})

test('says nothing about Lite models when one is usable, unknown, or the switch is off', async () => {
  for (const [value, usable] of [
    ['true', ['anthropic:claude-haiku-4-5:off']],
    ['true', undefined],
    ['false', []],
  ] as const) {
    const { container } = await renderSetting(value, undefined, usable ? [...usable] : undefined)
    expect(container.textContent).not.toContain(NO_MODEL)
    await dom!.cleanup()
    dom = undefined
  }
})

test('reflects a switched-off instance and needs settings:write to change', async () => {
  const { toggle } = await renderSetting('false', ['settings:read'])
  expect(toggle().checked).toBe(false)
  expect(toggle().disabled).toBe(true)
})
