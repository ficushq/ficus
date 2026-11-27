import { describe, expect, test } from 'bun:test'
import {
  isNeedsYouItemOpen,
  mergeNeedsYouNotices,
  needsYouNoticeCategory,
  needsYouNoticeContent,
  needsYouNoticeDestination,
  needsYouNoticesAllowed,
} from './needsYouNotices'
import {
  confirmNeedsYouCard,
  isWebKitEngine,
  NEEDS_YOU_PUSH_CHECK,
  needsYouPushActionId,
  needsYouPushWindows,
  subscribeNeedsYouPushChecks,
} from './needsYouPush'
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
    // A recovery decision ("Continue recovery?") is a halted agent's, not a new ask.
    expect(
      needsYouNoticeCategory(
        waitAction('w6', {
          type: 'workstream-blocked',
          wait: { structured: { request: { kind: 'continue', recoveryId: 'r1' } } as never },
        })
      )
    ).toBeNull()
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
  test('a question names its agent by type, the question and its work stream', () => {
    expect(needsYouNoticeContent(questionAction('q1'))).toEqual({
      who: 'Engineer',
      headline: 'Engineer has a question',
      detail: 'Retry on 409 as well?',
      context: '#8 · Make every payment retry safe',
    })
  })

  test('a notice names the agent by its configured type name when it is known', () => {
    const typeNames = (id: string) => (id === 'engineer' ? 'Builder' : undefined)
    expect(needsYouNoticeContent(questionAction('q1'), typeNames).headline).toBe('Builder has a question')
    expect(needsYouNoticeContent(waitAction('w1'), typeNames).who).toBe('Builder')
  })

  test('a question outside a work stream falls back to its squad, and names its agent by type only', () => {
    const content = needsYouNoticeContent(questionAction('q1', {}, { workStream: undefined }))
    expect(content.headline).toBe('Engineer has a question')
    expect(content.headline).not.toContain('Payments Engineer')
    expect(content.context).toBe('Product Engineering')
  })

  test('a review gate reads "<agent type> · review needed", as the lists do, with the work stream number and title', () => {
    expect(needsYouNoticeContent(waitAction('w1'))).toEqual({
      who: 'Engineer',
      headline: 'Engineer · review needed',
      detail: null,
      context: '#8 · Make every payment retry safe',
    })
  })

  test('a manual input gate says what it needs', () => {
    const content = needsYouNoticeContent(
      waitAction(
        'w2',
        { type: 'workstream-blocked', wait: { message: 'Pick the retry budget' } },
        { assigneeAgentTypeId: undefined }
      )
    )
    // An older server sends only the assignee's name, which is never shown alone.
    expect(content.headline).toBe('Blocked on your input')
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
  const focused = { focused: true, visibilityState: 'visible' as const, url: 'https://ficus.test/ficus/' }
  const isApp = (url: URL) => url.pathname.startsWith('/ficus/') && !url.pathname.startsWith('/ficus/docs')
  const push = { actionId: 'agent-question:q' }

  test('only question and gate pushes may have a card', () => {
    for (const actionId of ['agent-question:q', 'squad-question:a', 'workstream-review:w:1', 'workstream-blocked:w:1'])
      expect(needsYouPushActionId({ actionId })).toBe(actionId)
    expect(needsYouPushActionId({ actionId: 'agent-error:a' })).toBeNull()
    expect(needsYouPushActionId({ title: 'Done' })).toBeNull()
  })

  test('WebKit is every Safari and iOS browser, never desktop Chromium or Firefox', () => {
    expect(isWebKitEngine(safari)).toBe(true)
    expect(isWebKitEngine(iosChrome)).toBe(true)
    expect(isWebKitEngine(chrome)).toBe(false)
    expect(isWebKitEngine(firefox)).toBe(false)
  })

  test('Chromium and Firefox ask only focused, visible Ficus windows', () => {
    expect(needsYouPushWindows(push, chrome, [focused], isApp)).toEqual([focused])
    expect(needsYouPushWindows(push, firefox, [focused], isApp)).toEqual([focused])
    expect(needsYouPushWindows(push, chrome, [{ ...focused, focused: false }], isApp)).toEqual([])
    expect(needsYouPushWindows(push, chrome, [{ ...focused, visibilityState: 'hidden' }], isApp)).toEqual([])
    expect(needsYouPushWindows(push, chrome, [{ ...focused, url: 'https://ficus.test/ficus/docs/' }], isApp)).toEqual(
      []
    )
    expect(needsYouPushWindows({ actionId: 'agent-error:a' }, chrome, [focused], isApp)).toEqual([])
  })

  test('WebKit asks no window, so its notification always shows and its subscription is never revoked', () => {
    expect(needsYouPushWindows(push, safari, [focused], isApp)).toEqual([])
    expect(needsYouPushWindows(push, iosChrome, [focused], isApp)).toEqual([])
  })

  /** A window client that answers through the transferred port, or never (no card mounted). */
  function windowAnswering(answer: boolean | 'silent' | 'throws') {
    const asked: unknown[] = []
    return {
      asked,
      postMessage(message: unknown, [port]: Transferable[]) {
        if (answer === 'throws') throw new Error('gone')
        asked.push(message)
        if (answer !== 'silent') (port as MessagePort).postMessage({ shown: answer })
      },
    }
  }

  test('the notification is skipped only when a window confirms its card for that action', async () => {
    const yes = windowAnswering(true)
    expect(await confirmNeedsYouCard([windowAnswering(false), yes], 'agent-question:q', 500)).toBe(true)
    expect(yes.asked).toEqual([{ type: NEEDS_YOU_PUSH_CHECK, actionId: 'agent-question:q' }])
  })

  test('a no, no answer at all (a focused voice or sign-in window), or a failure shows the notification', async () => {
    expect(await confirmNeedsYouCard([windowAnswering(false)], 'agent-question:q', 500)).toBe(false)
    const started = Date.now()
    expect(await confirmNeedsYouCard([windowAnswering('silent')], 'agent-question:q', 60)).toBe(false)
    expect(Date.now() - started).toBeLessThan(450)
    expect(await confirmNeedsYouCard([windowAnswering('throws')], 'agent-question:q', 500)).toBe(false)
    expect(await confirmNeedsYouCard([], 'agent-question:q', 500)).toBe(false)
  })

  test('the page answers only its own service worker', async () => {
    const controller = { id: 'own worker' }
    const listeners: Array<(event: MessageEvent) => void> = []
    const container = {
      controller,
      addEventListener: (_type: string, listener: (event: MessageEvent) => void) => listeners.push(listener),
      removeEventListener: () => {},
    }
    const original = Object.getOwnPropertyDescriptor(navigator, 'serviceWorker')
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: container })
    try {
      const asked: string[] = []
      const unsubscribe = subscribeNeedsYouPushChecks(async (actionId) => {
        asked.push(actionId)
        return true
      })
      const ask = (source: unknown) => {
        const channel = new MessageChannel()
        const answer = new Promise<unknown>((resolve) => {
          channel.port1.onmessage = (event) => resolve(event.data)
        })
        const message = { type: NEEDS_YOU_PUSH_CHECK, actionId: 'agent-question:q' }
        for (const listener of listeners)
          listener({ data: message, ports: [channel.port2], source } as unknown as MessageEvent)
        return Promise.race([answer, new Promise((resolve) => setTimeout(() => resolve('no answer'), 50))]).finally(
          () => channel.port1.close()
        )
      }
      expect(await ask(controller)).toEqual({ shown: true })
      expect(await ask({ id: 'another worker' })).toBe('no answer')
      expect(await ask(null)).toBe('no answer')
      expect(asked).toEqual(['agent-question:q'])
      unsubscribe()
    } finally {
      if (original) Object.defineProperty(navigator, 'serviceWorker', original)
      else Reflect.deleteProperty(navigator, 'serviceWorker')
    }
  })
})
