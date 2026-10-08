import { describe, expect, test } from 'bun:test'
import { buildVoiceInstructions, type VoiceSessionContext } from './assistants/siteOperator/siteOperatorInstructions'

const baseContext: VoiceSessionContext = {
  squads: [],
  currentPath: '/settings?chat=open',
}

describe('buildVoiceInstructions', () => {
  test('includes current visible agent from Assistant text conversation', () => {
    const instructions = buildVoiceInstructions({
      ...baseContext,
      visibleAgents: [{ id: 'drawer-agent-id', source: 'system-manager-chat-drawer' }],
    })

    expect(instructions).toContain('Current primary visible agent ID: drawer-agent-id')
    expect(instructions).toContain('Primary visible agent source: Assistant text conversation')
  })

  test('identifies the squad coordinator without claiming an open conversation', () => {
    const instructions = buildVoiceInstructions({
      currentPath: '/squads/squad-1?tab=home',
      squads: [
        {
          id: 'squad-1',
          name: 'Engineering',
          purpose: 'Build things',
          status: 'active',
          agents: [{ id: 'manager-agent-id', agentTypeId: 'manager', status: 'idle' }],
        },
      ],
    })

    expect(instructions).toContain('Current squad manager ID: manager-agent-id')
    expect(instructions).not.toContain('Current primary visible agent ID: manager-agent-id')
    expect(instructions).not.toContain('Primary visible agent source: main page agent thread')
    expect(instructions).not.toContain('Visible agent (manager thread on home tab)')
  })

  test('keeps the coordinator distinct from an open Assistant conversation', () => {
    const instructions = buildVoiceInstructions({
      currentPath: '/squads/squad-1?tab=home',
      visibleAgents: [{ id: 'drawer-agent-id', source: 'system-manager-chat-drawer' }],
      squads: [
        {
          id: 'squad-1',
          name: 'Engineering',
          purpose: 'Build things',
          status: 'active',
          agents: [{ id: 'manager-agent-id', agentTypeId: 'manager', status: 'idle' }],
        },
      ],
    })

    expect(instructions).toContain('Current primary visible agent ID: drawer-agent-id')
    expect(instructions).toContain('Current squad manager ID: manager-agent-id')
    expect(instructions).not.toContain('- manager-agent-id (main page agent thread)')
  })

  test('includes secondary visible agents and disambiguation rules', () => {
    const instructions = buildVoiceInstructions({
      ...baseContext,
      visibleAgents: [
        { id: 'drawer-agent-id', source: 'system-manager-chat-drawer' },
        { id: 'page-agent-id', source: 'url' },
      ],
    })

    expect(instructions).toContain('Current primary visible agent ID: drawer-agent-id')
    expect(instructions).toContain('Other visible agent IDs:')
    expect(instructions).toContain('- page-agent-id (main page agent thread)')
    expect(instructions).toContain(
      'If multiple agents are visible and the request could apply to either, ask a short clarification.'
    )
  })
})

test('resolves the current squad slug and supplies full tool IDs', () => {
  const squadId = '11111111-1111-1111-1111-111111111111'
  const managerId = '22222222-2222-2222-2222-222222222222'
  const instructions = buildVoiceInstructions({
    currentPath: '/squads/ficus',
    squads: [
      {
        id: squadId,
        name: 'Ficus',
        purpose: null,
        status: 'active',
        createdAt: '2026-01-01',
        agents: [{ id: managerId, agentTypeId: 'manager', status: 'idle' }],
      },
    ],
  })
  expect(instructions).toContain(`Current squad ID: ${squadId}`)
  // Managers are listed by handle (first segment): shorter to copy, and the tools resolve it.
  expect(instructions).toContain('Current squad manager ID: 22222222')
  expect(instructions).toContain('manager: 22222222)')
  expect(instructions).not.toContain(managerId)
  expect(instructions).toContain('never assemble an ID from memory')
  expect(instructions).not.toContain('Current squad ID: ficus')
})

const sourceSquad = {
  id: 'source',
  name: 'Source',
  purpose: 'Manage Source project configuration',
  status: 'active',
  agents: [
    { id: 'source-manager', agentTypeId: 'manager', status: 'idle' },
    { id: 'source-worker', agentTypeId: 'engineer', status: 'idle' },
  ],
}

test('squad reports become squad tasks and instance-wide questions stay instance-wide on a squad page', () => {
  const instructions = buildVoiceInstructions({
    ...baseContext,
    currentPath: '/squads/source',
    squads: [sourceSquad as any],
  })
  expect(instructions).toContain('## Background tasks')
  expect(instructions).toContain('## Routing')
  expect(instructions).toContain('call delegate_task with that squad')
  expect(instructions).toContain('A new report does not need an existing work stream')
  expect(instructions).toContain('what schedules are enabled')
  expect(instructions).toContain('All of Ficus, or just Source?')
  expect(instructions).toContain('delete GITHUB_TOKEN and GITHUB_TOKEN_NOAHSASO env vars')
  expect(instructions).toContain('Current squad manager ID: source-manager')
  expect(instructions).not.toContain('source-worker')
  for (const gone of [
    'User Assistant',
    'message_user_assistant',
    'message_squad_manager',
    'message_work_stream_manager',
    'get_status',
    'list_attention',
    'show_conversation',
  ])
    expect(instructions).not.toContain(gone)
})

test('the prompt and tool definitions stay within the size budget', async () => {
  const { siteOperatorToolDefinitions } = await import('./assistants/siteOperator/siteOperatorTools')
  const { buildVoiceNavigationGuide } = await import('./navigationGuide')
  const squads = Array.from({ length: 4 }, (_, i) => ({
    id: `1111111${i}-1111-1111-1111-111111111111`,
    name: `Squad ${i}`,
    purpose: 'Build and operate a product surface for customers',
    status: 'active' as const,
    createdAt: '2026-01-01',
    agents: Array.from({ length: 8 }, (_, j) => ({
      id: `2222222${i}-2222-2222-2222-22222222222${j}`,
      agentTypeId: j ? 'engineer' : 'manager',
      status: 'idle',
    })),
  }))
  const instructions = buildVoiceInstructions({
    currentPath: `/squads/${squads[0]!.id}/work`,
    squads: squads as any,
  })
  // Budget: navigation guide ~5k (incl. ~2.5k settings descriptions, one line per settings page) + generated
  // squads/current screen ~1k + prose ~5k. Raised from 11.5k for the Decision Providers page.
  expect(instructions.length).toBeLessThan(11_750)
  expect(JSON.stringify(siteOperatorToolDefinitions).length).toBeLessThan(10_000)
  expect(instructions.split(buildVoiceNavigationGuide()).length).toBe(2)
})
