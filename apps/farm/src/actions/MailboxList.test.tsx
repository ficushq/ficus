import { afterEach, describe, expect, it, mock } from 'bun:test'
import type { ContinueHaltedActionsResult, ResolveWorkStreamWaitResult } from '@ficus/client-core'
import type { AgentQuestion, PendingAction } from '@ficus/shared'
import { ActionView } from './ActionView'
import {
  agentErrorAction,
  agentQuestionAction,
  assistantAction,
  deliveryAction,
  squadQuestionAction,
  stream,
  streamAction,
  wait,
  workflowRun,
} from './fixtures'
import { MailboxList } from './MailboxList'
import { StreamActions } from './StreamActions'
import { button, byLabel, cleanup, click, fakeApi, hasButton, render, typeInto } from './testing'

afterEach(cleanup)

describe('ActionView', () => {
  it('renders a question form for squad and agent questions', async () => {
    const api = fakeApi({ answerAgentQuestion: () => Promise.resolve({} as AgentQuestion) })
    const { container } = await render(<ActionView action={agentQuestionAction()} />, api)
    await typeInto(byLabel(container, 'Which color?'), 'Red')
    await click(button(container, 'Answer'))
    expect(api.answerAgentQuestion).toHaveBeenCalledWith('q-1', 'Red')

    const squad = await render(<ActionView action={squadQuestionAction()} />, api)
    expect(hasButton(squad.container, 'Answer')).toBe(true)
    expect(hasButton(squad.container, 'Dismiss')).toBe(false)
  })

  it('renders Wake up for a halted robot', async () => {
    const api = fakeApi({
      continueHaltedActions: (ids): Promise<ContinueHaltedActionsResult> =>
        Promise.resolve({ resumed: 1, resumedActionIds: ids, staleActionIds: [] }),
    })
    const { container } = await render(<ActionView action={agentErrorAction()} />, api)
    await click(button(container, 'Wake up'))
    expect(api.continueHaltedActions).toHaveBeenCalledWith(['agent-error:agent-3'])
  })

  it('renders Harvest / Prune for a review and Clear the weeds for a blocked stream', async () => {
    const api = fakeApi({ resolveWorkStreamWait: () => Promise.resolve({} as ResolveWorkStreamWaitResult) })
    const onFocusStream = mock((id: string) => id)
    const review = await render(<ActionView action={streamAction('review')} onFocusStream={onFocusStream} />, api)
    expect(hasButton(review.container, 'Harvest')).toBe(true)
    expect(hasButton(review.container, 'Prune')).toBe(true)
    await click(button(review.container, 'Go to plot'))
    expect(onFocusStream).toHaveBeenCalledWith('ws-1')

    const blocked = await render(<ActionView action={streamAction('blocked', { message: 'Stuck' })} />, api)
    expect(hasButton(blocked.container, 'Clear the weeds')).toBe(true)
  })

  it('explains an assistant task and opens its conversation', async () => {
    const api = fakeApi()
    const onOpenAssistant = mock((conversationId: string, taskId?: string) => [conversationId, taskId])
    const { container } = await render(<ActionView action={assistantAction()} onOpenAssistant={onOpenAssistant} />, api)
    expect(container.textContent).toContain('Saturday or Sunday?')
    expect(container.textContent).toContain('Plan the harvest festival')
    await click(button(container, 'Answer'))
    expect(onOpenAssistant).toHaveBeenCalledWith('conv-1', 'task-1')
  })

  it('links an assistant task to the web app without a callback', async () => {
    const { container } = await render(<ActionView action={assistantAction()} />, fakeApi())
    expect(container.querySelector('a')?.getAttribute('href')).toBe(
      '/?chat=open&assistantConversation=conv-1&assistantTask=task-1'
    )
  })

  it('links unknown action types to the web app', async () => {
    const future = { ...agentErrorAction(), id: 'robot-sings:1', type: 'robot-sings' } as unknown as PendingAction
    const { container } = await render(<ActionView action={future} />, fakeApi())
    expect(container.textContent).toContain("doesn't know this kind of request")
    expect(container.querySelector('a')?.getAttribute('href')).toBe('/actions/robot-sings%3A1')
  })

  it('links a view-only unknown type to the web app instead of the permission line', async () => {
    const future = {
      ...agentErrorAction(),
      id: 'robot-sings:2',
      type: 'robot-sings',
      canRespond: false,
    } as unknown as PendingAction
    const { container } = await render(<ActionView action={future} />, fakeApi())
    expect(container.textContent).not.toContain("don't have permission")
    expect(container.textContent).toContain("doesn't know this kind of request")
    expect(container.textContent).toContain('See it in the web app')
    expect(container.querySelector('a')?.getAttribute('href')).toBe('/actions/robot-sings%3A2')
  })

  describe('pull request review and merge gates', () => {
    const links = (container: HTMLElement) =>
      [...container.querySelectorAll('a')].map((a) => ({ text: a.textContent, href: a.getAttribute('href') }))

    it('says the stream waits on a review and links its one pull request inline', async () => {
      const onFocusStream = mock((_id: string) => {})
      const { container } = await render(
        <ActionView action={deliveryAction('review')} onFocusStream={onFocusStream} />,
        fakeApi()
      )
      expect(container.textContent).not.toContain("don't have permission")
      expect(container.textContent).toContain('Waiting on someone to review its pull request on the code host')
      expect(container.querySelector('ul')).toBeNull()
      expect(links(container)).toEqual([
        { text: 'Review #12acme/garden#12 on the code host', href: 'https://github.com/acme/garden/pull/12' },
      ])
      const link = container.querySelector('a')!
      expect(link.getAttribute('target')).toBe('_blank')
      expect(link.getAttribute('rel')).toBe('noreferrer')
      await click(button(container, 'Go to plot'))
      expect(onFocusStream).toHaveBeenCalledWith('ws-3')
    })

    it('says Open, not Merge, for a merge gate', async () => {
      const { container } = await render(<ActionView action={deliveryAction('merge')} />, fakeApi())
      expect(container.textContent).toContain('Waiting on someone to merge its pull request on the code host')
      expect(container.textContent).toContain('Open #12')
      expect(hasButton(container, 'Merge')).toBe(false)
    })

    it('lists several pull requests and skips ones without a link', async () => {
      const action = deliveryAction('review', [
        { repository: 'acme/garden', number: 12, url: 'https://github.com/acme/garden/pull/12' },
        { repository: 'acme/shed', number: 3, url: 'https://github.com/acme/shed/pull/3' },
        { repository: 'acme/barn', number: 7 },
      ])
      const { container } = await render(<ActionView action={action} />, fakeApi())
      expect(container.textContent).toContain('review its pull requests')
      const items = [...container.querySelectorAll('ul[aria-label="Pull requests"] li a')]
      expect(items.map((a) => a.getAttribute('href'))).toEqual([
        'https://github.com/acme/garden/pull/12',
        'https://github.com/acme/shed/pull/3',
      ])
    })

    it('opens the work stream in Ficus without a plot callback, and explains a missing link', async () => {
      const { container } = await render(<ActionView action={deliveryAction('review', [])} />, fakeApi())
      expect(container.textContent).toContain('Open the work stream in Ficus to find its pull request')
      expect(links(container)).toEqual([
        { text: 'Open work streamSee it in Ficus', href: '/squads/squad-1/work?ws=42' },
      ])
    })
  })

  it('does not offer controls without permission to respond', async () => {
    const { container } = await render(
      <ActionView action={streamAction('review', {}, {}, { canRespond: false })} />,
      fakeApi()
    )
    expect(container.querySelector('button')).toBeNull()
    expect(container.textContent).toContain("don't have permission")
  })
})

describe('MailboxList', () => {
  it('shows the sunny empty state', async () => {
    const { container } = await render(<MailboxList actions={[]} />, fakeApi())
    expect(container.textContent).toContain('Nothing needs you. Enjoy the sunshine.')
  })

  it('groups actions in the web order with collapsible letters', async () => {
    const actions = [
      streamAction('blocked', { id: 'w2', message: 'Stuck' }),
      streamAction('review'),
      assistantAction(),
      agentQuestionAction(),
      agentErrorAction('a'),
      agentErrorAction('b'),
      deliveryAction('merge'),
    ]
    const { container } = await render(<MailboxList actions={actions} />, fakeApi())
    const headings = [...container.querySelectorAll('h3')].map((h) => h.textContent)
    expect(headings).toEqual(['Halted robots 2', 'Questions 1', 'Assistant 1', 'Ready to harvest 2', 'Weeds 1'])
    expect(hasButton(container, 'Wake them all (2)')).toBe(true)

    const toggles = [...container.querySelectorAll<HTMLButtonElement>('button.g-mail-toggle')]
    expect(toggles).toHaveLength(7)
    const delivery = toggles.find((toggle) => toggle.textContent?.includes('merge pull request'))!
    expect(delivery.textContent).toContain('Plant pumpkins')
    await click(delivery)
    expect(container.textContent).toContain('Open #12')
    expect(container.textContent).not.toContain("don't have permission")
    await click(delivery)
    expect(toggles.every((toggle) => toggle.getAttribute('aria-expanded') === 'false')).toBe(true)
    const review = toggles.find((toggle) => toggle.textContent?.includes('Sprout requests review'))!
    await click(review)
    expect(review.getAttribute('aria-expanded')).toBe('true')
    expect(hasButton(container, 'Harvest')).toBe(true)
    await click(review)
    expect(hasButton(container, 'Harvest')).toBe(false)
  })

  it('opens a lone non-question action straight away, but not a lone question', async () => {
    const lone = await render(<MailboxList actions={[streamAction('review')]} />, fakeApi())
    expect(hasButton(lone.container, 'Harvest')).toBe(true)
    const question = await render(<MailboxList actions={[agentQuestionAction()]} />, fakeApi())
    expect(hasButton(question.container, 'Answer')).toBe(false)
  })
})

describe('StreamActions', () => {
  it('offers the review of a plain stream plus pausing', async () => {
    const api = fakeApi({
      workflowRun: () => Promise.resolve(null),
      getWorkStream: () => Promise.resolve(stream()),
    })
    const { container } = await render(<StreamActions stream={stream({ openWaits: [wait()] })} />, api)
    expect(hasButton(container, 'Harvest')).toBe(true)
    expect(hasButton(container, 'Pause')).toBe(true)
  })

  it('shows workflow decisions for a flow-driven stream', async () => {
    const api = fakeApi({
      workflowRun: () => Promise.resolve(workflowRun('delivery')),
      getWorkStream: () => Promise.resolve(stream()),
    })
    const { container } = await render(<StreamActions stream={stream()} showPauseControls={false} />, api)
    expect(hasButton(container, 'Harvest')).toBe(true)
    expect(hasButton(container, 'Pause')).toBe(false)
  })
})
