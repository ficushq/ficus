import { expect, test } from 'bun:test'
import { SQUAD_SETTINGS_SECTIONS, resolveSquadSettingsSection } from './squadNavigation'
import { SQUAD_SETTINGS_SEARCH } from '../components/squads/squadSettingsSearch'

test('legacy squad settings links land on their new owner including field targets', () => {
  for (const [old, current] of [
    ['policies', 'work'],
    ['workflows', 'work'],
    ['sandbox', 'workspace'],
    ['environment', 'workspace'],
    ['ssh', 'access'],
    ['remote-hosts', 'access'],
  ])
    expect(resolveSquadSettingsSection(old)).toBe(current)
  expect(resolveSquadSettingsSection('general', 'max-concurrent-work-streams')).toBe('work')
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

test('old Workflows links and their field targets open the Work page', () => {
  expect(SQUAD_SETTINGS_SECTIONS.find((section) => section.id === 'work')?.label).toBe('Work')
  expect(SQUAD_SETTINGS_SECTIONS.map((section) => section.id)).not.toContain('workflows')
  expect(resolveSquadSettingsSection('work')).toBe('work')
  for (const target of ['default-workflow', 'max-concurrent-work-streams', 'auto-park-grace-minutes', 'merge-policies'])
    expect(resolveSquadSettingsSection('workflows', target)).toBe('work')
  expect(resolveSquadSettingsSection(null, 'default-workflow')).toBe('work')
})
