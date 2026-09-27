import { expect, mock, test } from 'bun:test'
import * as squads from '../../api/squads'
import * as workspace from '../../api/workspace'
import { createAssistantTools } from './assistantTools'
const id = '11111111-1111-4111-8111-111111111111'
const squadDeps = {
  ...squads,
  listSquads: async () => [{ id, name: 'Ficus', createdAt: '2026-01-01', purpose: 'Development' }] as any,
}
const env = { navigate() {}, can: () => true }
function find(tools: ReturnType<typeof createAssistantTools>, name: string) {
  return tools.find((t) => t.definition.name === name)!
}
test('the manager and user-assistant message tools no longer exist', () => {
  const names = createAssistantTools().map((tool) => tool.definition.name)
  for (const gone of ['message_user_assistant', 'message_squad_manager', 'message_work_stream_manager'])
    expect(names).not.toContain(gone)
  expect(names).toContain('delegate_task')
})
test('memory, files, activity, and subscriptions resolve route slugs before calling permission-checked APIs', async () => {
  const memory = mock(async () => []),
    activity = mock(async () => []),
    subscribe = mock(async () => undefined)
  const file = mock(async () => ({ path: '/context.md', content: 'a'.repeat(13000), binary: false, size: 13000 }))
  const tools = createAssistantTools({
    squads: { ...squadDeps, listSquadActivity: activity as any, subscribeSquad: subscribe as any },
    searchMemory: memory as any,
    workspace: { ...workspace, getSquadMemoryFile: file },
  })
  await find(tools, 'read_squad_files').execute({ squadId: 'ficus', source: 'memory', query: 'context' }, env)
  expect(memory.mock.calls).toEqual([[id, { query: 'context', limit: 10 }]])
  await find(tools, 'read_activity').execute({ squadId: 'ficus', limit: 3 }, env)
  expect(activity.mock.calls).toEqual([[id, { limit: 3 }]])
  await find(tools, 'set_subscription').execute({ scope: 'squad', id: 'ficus', watching: true }, env)
  expect(subscribe.mock.calls).toEqual([[id]])
  const result = (await find(tools, 'read_squad_files').execute(
    { squadId: 'ficus', source: 'memory', path: '/context.md' },
    env
  )) as any
  expect(file.mock.calls).toEqual([[id, '/context.md']])
  expect(result.content.length).toBe(12000)
  expect(result.nextOffset).toBe(12000)
  await expect(
    find(tools, 'read_squad_files').execute({ squadId: 'ficus', source: 'workspace', query: 'x' }, env)
  ).rejects.toThrow()
  expect(memory).toHaveBeenCalledTimes(1)
})
test('invalid inputs never reach mutations and forbidden responses remain errors', async () => {
  const answer = mock(async () => {
    throw new Error('Forbidden')
  })
  const tools = createAssistantTools({ answerAgentQuestion: answer })
  await expect(find(tools, 'answer_question').execute({ questionId: 'q', answer: '' }, env)).rejects.toThrow()
  expect(answer).not.toHaveBeenCalled()
  await expect(
    find(tools, 'answer_question').execute({ questionId: 'q', answer: 'The user answer' }, env)
  ).rejects.toThrow('Forbidden')
  expect(answer.mock.calls).toEqual([['q', 'The user answer']])
})
test('delegate_task runs instance-wide without a squad and resolves squad slugs for squad tasks', async () => {
  const tools = createAssistantTools({ squads: squadDeps })
  const delegateTask = mock(async () => ({ id: 'message', agentId: 'helper', delivered: true, kind: 'background' }))
  expect(
    await find(tools, 'delegate_task').execute(
      { label: 'Check enabled schedules', request: 'Which schedules are enabled?' },
      { ...env, delegateTask }
    )
  ).toEqual({ id: 'message', agentId: 'helper', delivered: true, kind: 'background' })
  expect(delegateTask.mock.calls).toEqual([
    [
      'Which schedules are enabled?',
      { label: 'Check enabled schedules', squadId: undefined, mode: 'steer', inReplyTo: undefined },
    ],
  ])
  await find(tools, 'delegate_task').execute(
    { label: 'Pause deploy stream', request: 'Pause work stream Ship Ficus', squadId: 'ficus', mode: 'follow-up' },
    { ...env, delegateTask }
  )
  expect(delegateTask.mock.calls[1]).toEqual([
    'Pause work stream Ship Ficus',
    { label: 'Pause deploy stream', squadId: id, mode: 'follow-up', inReplyTo: undefined },
  ])
})

test('delegate_task rejects empty labels, unknown squads, and surfaces where delegation is unavailable', async () => {
  const delegateTask = mock(async () => ({}))
  const tools = createAssistantTools({ squads: squadDeps })
  await expect(
    find(tools, 'delegate_task').execute({ label: ' ', request: 'Work' }, { ...env, delegateTask })
  ).rejects.toThrow()
  await expect(
    find(tools, 'delegate_task').execute({ label: 'Task', request: 'Work', squadId: 'nope' }, { ...env, delegateTask })
  ).rejects.toThrow('Unknown or ambiguous squad')
  expect(delegateTask).not.toHaveBeenCalled()
  await expect(find(tools, 'delegate_task').execute({ label: 'Task', request: 'Work' }, env)).rejects.toThrow(
    'unavailable'
  )
})
test('search requests bounded backend results and retains explicit work context', async () => {
  const searchEntities = mock(async () => ({
    results: [
      {
        id,
        kind: 'work_stream' as const,
        label: 'Ship Ficus',
        detail: '',
        squadId: id,
        squadName: 'Ficus',
        status: 'active',
        updatedAt: '2026-01-01',
        score: 100,
      },
    ],
  }))
  const listAllWorkStreams = mock(async () => [])
  const tools = createAssistantTools({ searchEntities, squads: { ...squadDeps, listAllWorkStreams } })
  const result = (await find(tools, 'search_ficus').execute({ query: 'Ship Ficus', limit: 3 }, env)) as any
  expect(searchEntities.mock.calls).toEqual([['Ship Ficus', 3]])
  expect(listAllWorkStreams).not.toHaveBeenCalled()
  expect(result.results[0]).toMatchObject({
    id,
    workStreamId: id,
    squadId: id,
    squadName: 'Ficus',
    path: `/squads/${id}/work?ws=${id}`,
  })
})

test('answer_question dismisses with a flag and never both answers and dismisses', async () => {
  const answer = mock(async () => ({ ok: true }))
  const dismiss = mock(async () => ({ ok: true }))
  const tools = createAssistantTools({ answerAgentQuestion: answer as any, dismissAgentQuestion: dismiss as any })
  await find(tools, 'answer_question').execute({ questionId: 'q', dismiss: true, reason: 'stale' }, env)
  expect(dismiss.mock.calls).toEqual([['q', 'stale']])
  expect(answer).not.toHaveBeenCalled()
  await expect(
    find(tools, 'answer_question').execute({ questionId: 'q', dismiss: true, answer: 'x' }, env)
  ).rejects.toThrow()
  await expect(find(tools, 'answer_question').execute({ questionId: 'q' }, env)).rejects.toThrow()
  expect(answer).not.toHaveBeenCalled()
})

test('read_inbox views call the action center or the notification inbox', async () => {
  const listPendingActions = mock(async () => [{ id: 'a1' }])
  const getMyInbox = mock(async () => [
    {
      id: 'n1',
      readAt: null,
      subject: null,
      content: 'new',
      senderType: 'agent',
      senderId: 'x',
      createdAt: '2026-01-01',
    },
    {
      id: 'n2',
      readAt: '2026-01-01',
      subject: null,
      content: 'old',
      senderType: 'agent',
      senderId: 'x',
      createdAt: '2026-01-01',
    },
  ])
  const tools = createAssistantTools({ listPendingActions: listPendingActions as any, getMyInbox: getMyInbox as any })
  expect(await find(tools, 'read_inbox').execute({ view: 'actions' }, env)).toEqual([{ id: 'a1' }])
  const unread = (await find(tools, 'read_inbox').execute({ view: 'notifications' }, env)) as any
  expect(getMyInbox.mock.calls).toEqual([[false]])
  expect(unread.messages.map((m: any) => m.id)).toEqual(['n1'])
  const all = (await find(tools, 'read_inbox').execute({ view: 'notifications', status: 'all' }, env)) as any
  expect(getMyInbox.mock.calls[1]).toEqual([true])
  expect(all.messages.map((m: any) => m.id)).toEqual(['n1', 'n2'])
})

test('navigate takes exactly one of path, agentId, or drawer', async () => {
  const getAgent = mock(
    async (agentId: string) =>
      ({ id: agentId, squadId: 'squad', agentTypeId: 'manager', metadata: { name: 'Morgan' } }) as any
  )
  const openConversation = mock()
  const navigate = mock()
  const tools = createAssistantTools({ getAgent })
  const nav = find(tools, 'navigate')
  const envWith = { navigate, openConversation, getCurrentPath: () => '/settings?section=providers' }
  expect(await nav.execute({ path: '/squads/ficus' }, envWith)).toEqual({ ok: true, navigatedTo: '/squads/ficus' })
  expect(navigate.mock.calls).toEqual([['/squads/ficus']])
  const offered = (await nav.execute({ agentId: 'manager' }, envWith)) as any
  expect(offered.conversation).toMatchObject({ agentId: 'manager', squadId: 'squad', label: 'Morgan' })
  expect(openConversation).not.toHaveBeenCalled()
  await nav.execute({ agentId: 'manager', open: true }, envWith)
  expect(openConversation.mock.calls).toEqual([[offered.conversation]])
  expect(await nav.execute({ drawer: 'open' }, envWith)).toEqual({
    ok: true,
    drawerState: 'open',
    navigatedTo: '/settings?section=providers&chat=open',
  })
  expect(navigate.mock.calls).toHaveLength(2)
  await expect(nav.execute({}, envWith)).rejects.toThrow()
  await expect(nav.execute({ path: '/x', drawer: 'open' }, envWith)).rejects.toThrow()
})
