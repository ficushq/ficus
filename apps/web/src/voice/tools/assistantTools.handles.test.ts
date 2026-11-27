import { expect, mock, test } from 'bun:test'
import { createAssistantTools } from './assistantTools'

test('navigate resolves an agent handle to the unique live agent before offering its conversation', async () => {
  const morgan = {
    id: 'bbbbbbbb-2222-4222-8222-222222222222',
    squadId: 'squad',
    agentTypeId: 'manager',
    status: 'idle',
    metadata: { name: 'Morgan' },
  }
  const getAgent = mock(async (id: string) => {
    if (id !== morgan.id) throw new Error('API error: 404: Agent not found')
    return morgan as any
  })
  const listAgents = mock(async () => [morgan] as any)
  const tools = createAssistantTools({ getAgent, listAgents })
  const navigate = tools.find((tool) => tool.definition.name === 'navigate')!
  const offered = (await navigate.execute({ agentId: 'bbbbbbbb' }, { navigate() {} })) as any
  expect(offered.conversation).toMatchObject({ agentId: morgan.id, label: 'Manager' })
  expect(listAgents).toHaveBeenCalledTimes(1)
})

test('a squad manager chat named by its handle opens in the squad Chats tab, never the legacy page', async () => {
  const { buildVoiceInstructions } = await import('../assistants/siteOperator/siteOperatorInstructions')
  const { agentChatPath } = await import('../../lib/entityReference')
  const manager = {
    id: 'aaaaaaaa-1111-4111-8111-111111111111',
    squadId: 'source-squad-id',
    agentTypeId: 'manager',
    status: 'idle',
    metadata: { name: 'Source manager' },
  }
  const loner = { id: 'cccccccc-3333-4333-8333-333333333333', agentTypeId: 'assistant', status: 'idle', metadata: {} }
  const instructions = buildVoiceInstructions({
    squads: [{ id: manager.squadId, name: 'Source', status: 'active', agents: [manager] }],
  } as any)
  // The Assistant only ever sees the manager's handle.
  const handle = instructions.match(/\*\*Source\*\* \(id: source-squad-id, manager: (\w+)\)/)?.[1]
  expect(handle).toBe('aaaaaaaa')
  const agents = [manager, loner]
  const getAgent = mock(async (id: string) => {
    const agent = agents.find((candidate) => candidate.id === id)
    if (!agent) throw new Error('API error: 404: Agent not found')
    return agent as any
  })
  const listAgents = mock(async () => agents as any)
  const navigateTool = createAssistantTools({ getAgent, listAgents }).find((t) => t.definition.name === 'navigate')!
  const navigate = mock()
  const openConversation = mock()
  const env = { navigate, openConversation }
  const chatsTab = `/squads/source-squad-id/agents?agent=${manager.id}`

  for (const path of [
    `/squads/source-squad-id/agents?agent=${handle}`,
    `/squads/source/agents?agent=${handle}`,
    `/squads/source-squad-id/agents?agent=${manager.id}`,
    `/chat/${handle}`,
  ])
    expect(await navigateTool.execute({ path }, env)).toEqual({ ok: true, navigatedTo: chatsTab })
  expect(navigate.mock.calls).toEqual([[chatsTab], [chatsTab], [chatsTab], [chatsTab]])
  expect(await navigateTool.execute({ path: `/squads/source/agents?view=inbox&agent=${handle}#latest` }, env)).toEqual({
    ok: true,
    navigatedTo: `/squads/source-squad-id/agents?view=inbox&agent=${manager.id}#latest`,
  })

  // The in-Assistant route lands on the same squad agent, whose page link is the Chats tab.
  const opened = (await navigateTool.execute({ agentId: handle, open: true }, env)) as any
  expect(openConversation.mock.calls).toEqual([[opened.conversation]])
  expect(opened.conversation).toMatchObject({ agentId: manager.id, squadId: manager.squadId })
  expect(agentChatPath({ id: opened.conversation.agentId, squadId: opened.conversation.squadId })).toBe(chatsTab)

  // Paths without an agent pass through untouched; the legacy page itself is never a destination.
  expect(await navigateTool.execute({ path: '/squads/source/agents' }, env)).toEqual({
    ok: true,
    navigatedTo: '/squads/source/agents',
  })
  navigate.mockClear()
  await expect(navigateTool.execute({ path: '/chat' }, env)).rejects.toThrow('squad Chats tab')
  await expect(navigateTool.execute({ path: '/chat/cccccccc' }, env)).rejects.toThrow('navigate agentId and open=true')
  await expect(navigateTool.execute({ path: '/squads/source/agents?agent=dddddddd' }, env)).rejects.toThrow(
    'Unknown agent'
  )
  expect(navigate).not.toHaveBeenCalled()
})
