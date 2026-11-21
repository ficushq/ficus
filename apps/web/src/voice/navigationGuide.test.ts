import { expect, test } from 'bun:test'
import { SQUAD_TABS, SQUAD_SETTINGS_SECTIONS } from '../lib/squadNavigation'
import { ALL_SECTIONS } from '../components/settings/settingsSections'
import { visibleNavItems } from '../components/navModel'
import { buildVoiceNavigationGuide } from './navigationGuide'
import { createAssistantTools } from './tools/assistantTools'

const navigationTool = createAssistantTools().find((t) => t.definition.name === 'navigate')!

test('voice navigation follows the shared UI definitions and canonical squad paths', () => {
  const guide = buildVoiceNavigationGuide()
  expect(navigationTool.definition.description.length).toBeLessThan(600)
  expect(navigationTool.definition.description).toContain('Navigation section')
  for (const tab of SQUAD_TABS) expect(guide).toContain(`${tab.label}: /squads/:squadId/${tab.path}`)
  for (const section of SQUAD_SETTINGS_SECTIONS)
    expect(guide).toContain(`/squads/:squadId/settings?section=${section.id}`)
  for (const section of ALL_SECTIONS) expect(guide).toContain(`${section.label}: /settings?section=${section.id}`)
  for (const item of visibleNavItems) expect(guide).toContain(`${item.label}: ${item.to}`)
  expect(guide).toContain('Chats: /squads/:squadId/agents')
  expect(guide).toContain('/squads/:squadId/work?ws=:workStreamId')
  expect(guide).not.toContain('/chat — Chat list')
  expect(guide).not.toContain('bottom-right')
})

test('settings navigation includes a description for every destination without implying access to form values', () => {
  const guide = buildVoiceNavigationGuide()
  for (const section of ALL_SECTIONS) {
    expect(section.description.length).toBeGreaterThan(10)
    expect(guide).toContain(section.description)
  }
  expect(guide).toContain('not live values')
})

test('nothing the Assistant reads points it at the legacy /chat page', async () => {
  const { buildVoiceInstructions } = await import('./assistants/siteOperator/siteOperatorInstructions')
  const { siteOperatorToolDefinitions } = await import('./assistants/siteOperator/siteOperatorTools')
  const { assistantSearch } = await import('../lib/assistantSearch')
  const legacyRoute = /(^|[^?&\w])\/chat(?![\w-])/
  const instructions = buildVoiceInstructions({
    currentPath: '/squads/squad-1/home',
    squads: [
      {
        id: 'squad-1',
        name: 'Source',
        status: 'active',
        agents: [{ id: 'aaaaaaaa-1111-4111-8111-111111111111', agentTypeId: 'manager', status: 'idle' }],
      },
    ],
  } as any)
  expect(instructions).not.toMatch(legacyRoute)
  expect(instructions).toContain('/squads/:squadId/agents?agent=:agentId (an agent handle works)')
  expect(JSON.stringify(siteOperatorToolDefinitions)).not.toMatch(legacyRoute)
  for (const query of ['chat', 'chats', 'manager chat'])
    for (const row of assistantSearch(query, [], [], new Set()) as any[])
      expect(row.path ?? '').not.toMatch(legacyRoute)
  // The guard itself still recognizes the route it protects against.
  expect('threads use /chat/:agentId.').toMatch(legacyRoute)
  expect('/?chat=open').not.toMatch(legacyRoute)
})
