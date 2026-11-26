import { describe, expect, test } from 'bun:test'
import {
  isNeedsYouItemOpen,
  mergeNeedsYouNotices,
  needsYouNoticeCategory,
  needsYouNoticeContent,
  needsYouNoticeDestination,
  needsYouNoticesAllowed,
} from './needsYouNotices'
import { isNeedsYouPush, isWebKitEngine, shouldSkipPushNotification } from './needsYouPush'
import { otherAction, questionAction, waitAction } from './needsYouNotices.fixtures'

const at = (path: string) => {
  const url = new URL(path, 'http://ficus.test')
  return { pathname: url.pathname, search: url.search }
}

describe('needs-you notice triggers', () => {
  test('only questions the user can answer and gates the user can decide raise a notice', () => {
    expect(needsYouNoticeCategory(questionAction('q1'))).toBe('question')
    expect(needsYouNoticeCategory({ ...otherAction('squad-question', 'a'), canRespond: true })).toBe('question')
    expect(needsYouNoticeCategory(waitAction('w1'))).toBe('review')
    expect(needsYouNoticeCategory(waitAction('w2', { type: 'workstream-blocked' }))).toBe('review')

    expect(needsYouNoticeCategory(questionAction('q2', { canRespond: false }))).toBeNull()
    // Listed at Show (or by an older server) but not alerting: no notice.
    expect(needsYouNoticeCategory(questionAction('q4', { alerts: undefined }))).toBeNull()
    expect(needsYouNoticeCategory(waitAction('w5', { alerts: false }))).toBeNull()
    expect(needsYouNoticeCategory(waitAction('w3', { canRespond: false }))).toBeNull()
    for (const type of ['agent-error', 'assistant-needs-input', 'workstream-delivery'] as const)
      expect(needsYouNoticeCategory(otherAction(type, 'x'))).toBeNull()
  })

  test('an answered question whose delivery failed is not a new ask', () => {
    const failed = questionAction(
      'q3',
      {},
      {
        answerDelivery: {
          status: 'failed',
          generation: 1,
          attemptCount: 3,
          nextAttemptAt: null,
          lastError: 'gone',
          deliveredAt: null,
        } as never,
      }
    )
    expect(needsYouNoticeCategory(failed)).toBeNull()
  })
})

describe('needs-you notice preferences', () => {
  test('follow the push master switch and category mutes, and show nothing before they load', () => {
    expect(needsYouNoticesAllowed({ pushEnabled: true, mutedEvents: [] }, 'question')).toBe(true)
    expect(needsYouNoticesAllowed({ pushEnabled: false, mutedEvents: [] }, 'question')).toBe(false)
    expect(needsYouNoticesAllowed({ pushEnabled: true, mutedEvents: ['question'] }, 'question')).toBe(false)
    expect(needsYouNoticesAllowed({ pushEnabled: true, mutedEvents: ['question'] }, 'review')).toBe(true)
    expect(needsYouNoticesAllowed({ pushEnabled: true, mutedEvents: ['review'] }, 'review')).toBe(false)
    expect(needsYouNoticesAllowed({ pushEnabled: true, mutedEvents: ['agent-question.created'] }, 'question')).toBe(
      false
    )
    expect(needsYouNoticesAllowed(undefined, 'review')).toBe(false)
  })
})

describe('needs-you notice content', () => {
  test('a question names its agent, the question and its work stream', () => {
    expect(needsYouNoticeContent(questionAction('q1'))).toEqual({
      who: 'Payments Engineer',
      headline: 'Payments Engineer has a question',
      detail: 'Retry on 409 as well?',
      context: '#8 · Make every payment retry safe',
    })
  })

  test('a question outside a work stream falls back to its squad, and a nameless agent to its role', () => {
    const content = needsYouNoticeContent(questionAction('q1', {}, { agentName: null, workStream: undefined }))
    expect(content.headline).toBe('engineer has a question')
    expect(content.context).toBe('Product Engineering')
  })

  test('a review gate reads "<agent> requests review" with the work stream number and title', () => {
    expect(needsYouNoticeContent(waitAction('w1'))).toEqual({
      who: 'Payments Engineer',
      headline: 'Payments Engineer requests review',
      detail: null,
      context: '#8 · Make every payment retry safe',
    })
  })

  test('a manual input gate says what it needs', () => {
    const content = needsYouNoticeContent(
      waitAction('w2', { type: 'workstream-blocked', wait: { message: 'Pick the retry budget' } })
    )
    expect(content.headline).toBe('Payments Engineer needs your input')
    expect(content.detail).toBe('Pick the retry budget')
  })
})

describe('needs-you notice destination', () => {
  test('a question or a plain wait opens the item in the Action Center', () => {
    expect(needsYouNoticeDestination(questionAction('q1'), at('/squads'))).toBe('/actions/agent-question%3Aq1')
    expect(needsYouNoticeDestination(waitAction('w1'), at('/'))).toBe(
      `/actions/${encodeURIComponent('workstream-review:ws-uuid-8:w1')}`
    )
  })

  test('a workflow gate opens its review over the current page, like Review in Needs you', () => {
    const gate = waitAction('w4', { type: 'workstream-blocked', wait: { resolutionHandler: 'workflow' } })
    expect(needsYouNoticeDestination(gate, at('/squads/eng/work?tab=x'))).toBe(
      '/squads/eng/work?tab=x&review=ws-uuid-8&reviewWait=w4'
    )
  })
})

describe('needs-you item already open', () => {
  test('the item in the Action Center', () => {
    expect(isNeedsYouItemOpen(questionAction('q1'), at('/actions/agent-question%3Aq1'))).toBe(true)
    expect(isNeedsYouItemOpen(questionAction('q1'), at('/actions/agent-question%3Aq2'))).toBe(false)
  })

  test("the asking agent's conversation, by squad id or slug", () => {
    expect(isNeedsYouItemOpen(questionAction('q1'), at('/squads/squad-1/agents?agent=agent-1'))).toBe(true)
    expect(isNeedsYouItemOpen(questionAction('q1'), at('/squads/product-engineering/agents?agent=agent-1'))).toBe(true)
    expect(isNeedsYouItemOpen(questionAction('q1'), at('/squads/squad-1/agents?agent=agent-2'))).toBe(false)
  })

  test("the work stream's review or detail, by id or number", () => {
    expect(isNeedsYouItemOpen(waitAction('w1'), at('/?review=8'))).toBe(true)
    expect(isNeedsYouItemOpen(waitAction('w1'), at('/squads/eng/work?ws=ws-uuid-8'))).toBe(true)
    expect(isNeedsYouItemOpen(questionAction('q1'), at('/?ws=8'))).toBe(true)
    expect(isNeedsYouItemOpen(waitAction('w1'), at('/?ws=9'))).toBe(false)
  })
})

test('more than three pending notices keeps the newest three', () => {
  const actions = [1, 2, 3, 4].map((minute) =>
    questionAction(`q${minute}`, { createdAt: `2026-11-26T12:0${minute}:00.000Z` })
  )
  expect(mergeNeedsYouNotices(actions.slice(0, 2), actions.slice(2)).map((action) => action.id)).toEqual([
    'agent-question:q4',
    'agent-question:q3',
    'agent-question:q2',
  ])
})

describe('push notifications while a Ficus window is focused', () => {
  const chrome =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
  const firefox = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:133.0) Gecko/20100101 Firefox/133.0'
  const safari =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15'
  const iosChrome =
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/131.0 Mobile/15E148 Safari/604.1'
  const focused = [{ focused: true, visibilityState: 'visible' as const, url: 'https://ficus.test/ficus/' }]
  const isApp = (url: URL) => url.pathname.startsWith('/ficus/') && !url.pathname.startsWith('/ficus/docs')

  test('only question and review pushes are Needs-you pushes', () => {
    for (const actionId of ['agent-question:q', 'squad-question:a', 'workstream-review:w:1', 'workstream-blocked:w:1'])
      expect(isNeedsYouPush({ actionId })).toBe(true)
    expect(isNeedsYouPush({ actionId: 'agent-error:a' })).toBe(false)
    expect(isNeedsYouPush({ title: 'Done' })).toBe(false)
  })

  test('WebKit is every Safari and iOS browser, never desktop Chromium or Firefox', () => {
    expect(isWebKitEngine(safari)).toBe(true)
    expect(isWebKitEngine(iosChrome)).toBe(true)
    expect(isWebKitEngine(chrome)).toBe(false)
    expect(isWebKitEngine(firefox)).toBe(false)
  })

  test('Chromium and Firefox skip a Needs-you notification while a Ficus window is focused', () => {
    const push = { actionId: 'agent-question:q' }
    expect(shouldSkipPushNotification(push, chrome, focused, isApp)).toBe(true)
    expect(shouldSkipPushNotification(push, firefox, focused, isApp)).toBe(true)
    // Not focused, hidden, or a sibling app on the same origin: the OS notification shows.
    expect(shouldSkipPushNotification(push, chrome, [{ ...focused[0]!, focused: false }], isApp)).toBe(false)
    expect(shouldSkipPushNotification(push, chrome, [{ ...focused[0]!, visibilityState: 'hidden' }], isApp)).toBe(false)
    expect(
      shouldSkipPushNotification(push, chrome, [{ ...focused[0]!, url: 'https://ficus.test/ficus/docs/' }], isApp)
    ).toBe(false)
    // Other pushes always show.
    expect(shouldSkipPushNotification({ actionId: 'agent-error:a' }, chrome, focused, isApp)).toBe(false)
  })

  test('WebKit always shows the notification, so its subscription is never revoked', () => {
    expect(shouldSkipPushNotification({ actionId: 'agent-question:q' }, safari, focused, isApp)).toBe(false)
    expect(shouldSkipPushNotification({ actionId: 'agent-question:q' }, iosChrome, focused, isApp)).toBe(false)
  })
})
