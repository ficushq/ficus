import { expect, test } from 'bun:test'
import { SQUAD_SETTINGS_SECTIONS, resolveSquadSettingsSection } from './squadNavigation'
import { SQUAD_SETTINGS_SEARCH } from '../components/squads/squadSettingsSearch'

test('legacy squad settings links land on their new owner including field targets', () => {
  for (const [old, current] of [
    ['policies', 'workflows'],
    ['sandbox', 'workspace'],
    ['environment', 'workspace'],
    ['ssh', 'access'],
    ['remote-hosts', 'access'],
  ])
    expect(resolveSquadSettingsSection(old)).toBe(current)
  expect(resolveSquadSettingsSection('general', 'max-concurrent-work-streams')).toBe('workflows')
  expect(resolveSquadSettingsSection(null, 'host-workspace-directory')).toBe('workspace')
  expect(resolveSquadSettingsSection('general', 'name')).toBe('general')
  const ids = SQUAD_SETTINGS_SECTIONS.map((s) => s.id)
  for (const entry of SQUAD_SETTINGS_SEARCH) expect(ids).toContain(entry.section)
})

test('Git identity search and old integration links open Workspace', () => {
  for (const target of ['sandbox-github-identity', 'git-author-name', 'git-author-email']) {
    expect(resolveSquadSettingsSection('integrations', target)).toBe('workspace')
    expect(resolveSquadSettingsSection(null, target)).toBe('workspace')
    expect(SQUAD_SETTINGS_SEARCH.find((entry) => entry.id === target)?.section).toBe('workspace')
  }
})

test('the Work settings page keeps its workflows id so existing links resolve', () => {
  expect(SQUAD_SETTINGS_SECTIONS.find((section) => section.id === 'workflows')?.label).toBe('Work')
  expect(resolveSquadSettingsSection('workflows')).toBe('workflows')
  expect(resolveSquadSettingsSection('workflows', 'merge-policies')).toBe('workflows')
  expect(resolveSquadSettingsSection(null, 'default-workflow')).toBe('workflows')
})
