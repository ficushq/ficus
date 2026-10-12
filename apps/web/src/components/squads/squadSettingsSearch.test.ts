import { expect, test } from 'bun:test'
import { matchesSetting } from '../settings/settingsSearch'
import { resolveSquadSettingsSection } from '../../lib/squadNavigation'
import {
  ARCHIVE_SQUAD_SETTING_ID,
  SQUAD_SETTINGS_KEYWORDS,
  SQUAD_SETTINGS_SEARCH,
  squadSettingsSearchEntries,
} from './squadSettingsSearch'

const available = { hostRuntime: true, sandboxSectionReady: true, canDeleteSquad: true }

test('archive, delete, and remove squad find the archive action in General', () => {
  const entry = SQUAD_SETTINGS_SEARCH.find((candidate) => candidate.id === ARCHIVE_SQUAD_SETTING_ID)!
  expect(entry.section).toBe('general')
  expect(entry.label).toBe('Archive squad')
  for (const query of ['archive', 'Archive squad', 'delete squad', 'remove squad', 'delete', 'danger zone']) {
    expect(matchesSetting(query, entry.label, entry.keywords, 'General')).toBe(true)
    expect(matchesSetting(query, 'General', 'Squad', SQUAD_SETTINGS_KEYWORDS.general!)).toBe(true)
  }
  // The destination stays in General: no legacy remap steals the target.
  expect(resolveSquadSettingsSection(null, ARCHIVE_SQUAD_SETTING_ID)).toBe('general')
  expect(resolveSquadSettingsSection('general', ARCHIVE_SQUAD_SETTING_ID)).toBe('general')
})

test('search offers the archive action only to users who can see its block', () => {
  const ids = (options: Parameters<typeof squadSettingsSearchEntries>[0]) =>
    squadSettingsSearchEntries(options).map((entry) => entry.id)

  expect(ids(available)).toContain(ARCHIVE_SQUAD_SETTING_ID)
  expect(ids({ ...available, canDeleteSquad: false })).not.toContain(ARCHIVE_SQUAD_SETTING_ID)
  expect(squadSettingsSearchEntries(available)).toHaveLength(SQUAD_SETTINGS_SEARCH.length)
})

test('runtime-specific entries keep following the sandbox runtime', () => {
  const ids = (options: Parameters<typeof squadSettingsSearchEntries>[0]) =>
    squadSettingsSearchEntries(options).map((entry) => entry.id)

  expect(ids({ ...available, hostRuntime: false })).not.toContain('host-workspace-directory')
  for (const id of ['sandbox-lifecycle', 'idle-timeout', 'ephemeral-storage-limit'])
    expect(ids({ ...available, sandboxSectionReady: false })).not.toContain(id)
  expect(ids({ hostRuntime: false, sandboxSectionReady: false, canDeleteSquad: false })).toContain('name')
})
