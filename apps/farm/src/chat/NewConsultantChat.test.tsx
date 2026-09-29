import { afterEach, describe, expect, it, spyOn } from 'bun:test'
import { queryKeys } from '@ficus/client-core'
import { NewConsultantChat } from './NewConsultantChat'
import {
  act,
  createTestQueryClient,
  keyDown,
  makeAgent,
  makeFakeClient,
  makeMessage,
  render,
  typeInto,
  waitFor,
} from './testing'

const mounted: Array<() => void> = []
afterEach(() => {
  for (const unmount of mounted.splice(0)) unmount()
  localStorage.clear()
})

const composer = (root: ParentNode) => root.querySelector<HTMLTextAreaElement>('textarea.g-chat-input')!
const composerLabel = (root: ParentNode) => root.querySelector(`label[for="${composer(root).id}"]`)?.textContent

describe('NewConsultantChat', () => {
  it('starts a consultant with the squad scope, then hands off to the agent chat', async () => {
    const firstMessage = makeMessage({
      id: 'm1',
      agentId: 'c1',
      role: 'human',
      content: 'Plan the spring beds',
      pending: true,
    })
    const fake = makeFakeClient({
      agents: { c1: makeAgent({ id: 'c1', agentTypeId: 'consultant', squadId: 's1', status: 'active' }) },
      messages: { c1: [firstMessage] },
    })
    const queryClient = createTestQueryClient()
    const invalidate = spyOn(queryClient, 'invalidateQueries')
    const started: string[] = []
    const view = await render(
      <NewConsultantChat squadId="s1" squadName="Tomatoes" onClose={() => {}} onStarted={(id) => started.push(id)} />,
      { client: fake.client, queryClient }
    )
    mounted.push(view.unmount)
    const root = view.container

    expect(root.textContent).toContain('What shall we grow in Tomatoes?')
    expect(root.querySelector('h2')?.textContent).toBe('New consultant')
    await waitFor(() => expect(composer(root).disabled).toBe(false))
    expect(composerLabel(root)).toBe('Message a new consultant for Tomatoes')

    typeInto(composer(root), 'Plan the spring beds')
    await keyDown(composer(root), { key: 'Enter' })
    await waitFor(() => expect(fake.chatSent).toHaveLength(1))
    expect(fake.chatSent[0]).toMatchObject({
      message: 'Plan the spring beds',
      scope: { type: 'consultant', id: 's1' },
      deliveryMode: 'steer',
    })
    expect(fake.chatSent[0].agentId).toBeUndefined()
    expect(fake.sent).toHaveLength(0)
    // The optimistic first message stays on screen while the consultant is created.
    await waitFor(() => expect(root.textContent).toContain('Plan the spring beds'))

    // The chat stream announces the new consultant's id.
    firstMessage.metadata = { clientId: fake.chatSent[0].clientId }
    await act(async () => {
      fake.chat()?.onEvent({ type: 'agent', agentId: 'c1' })
      fake.chat()?.onEvent({ type: 'text', text: 'Happy to help', streamGroupId: 'S1' })
      await Promise.resolve()
    })

    await waitFor(() => expect(started).toEqual(['c1']))
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.squads.agents('s1') })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.squads.agentsWithRecent('s1') })

    // Handed off: the regular agent conversation for c1, first message still there.
    await waitFor(() => expect(composerLabel(root)).toBe('Message'))
    expect(root.querySelector('h2')?.textContent).toBe('Consultant')
    expect(root.textContent).not.toContain('What shall we grow')
    await waitFor(() => expect(root.textContent).toContain('Plan the spring beds'))
    await waitFor(() => expect(fake.stream('c1')).toBeDefined())

    // Later messages go to the consultant directly.
    await waitFor(() => expect(composer(root).disabled).toBe(false))
    typeInto(composer(root), 'Add basil')
    await keyDown(composer(root), { key: 'Enter' })
    await waitFor(() => expect(fake.sent.map((s) => [s.agentId, s.content])).toEqual([['c1', 'Add basil']]))
    expect(fake.chatSent).toHaveLength(1)
  })
})
