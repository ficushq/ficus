import { afterEach, expect, mock, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { SettingMetadata } from '../../api/settings'
import { PermissionsProvider } from '../../hooks/usePermissions'
import { queries } from '../../queryOptions'
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

async function renderSetting(value: string, permissions: string[] = ['settings:read', 'settings:write']) {
  dom = await acquireDomHarness({ url: 'http://localhost/' })
  const { root, container } = dom.createRoot()
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(queries.settings.list().queryKey, [setting(value)])
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
            <ReplySuggestionsSetting />
          </SettingsApiProvider>
        </PermissionsProvider>
      </QueryClientProvider>
    )
  )
  const toggle = () => container.querySelector<HTMLInputElement>('input[role="switch"]')!
  return { container, toggle, setSetting }
}

test('shows the switch on, and turning it off saves the setting', async () => {
  const { container, toggle, setSetting } = await renderSetting('true')
  expect(container.textContent).toContain('Reply suggestions')
  expect(toggle().checked).toBe(true)
  await dom!.act(async () => toggle().click())
  expect(setSetting.mock.calls).toEqual([[REPLY_SUGGESTIONS_SETTING, 'false']])
})

test('reflects a switched-off instance and needs settings:write to change', async () => {
  const { toggle } = await renderSetting('false', ['settings:read'])
  expect(toggle().checked).toBe(false)
  expect(toggle().disabled).toBe(true)
})
