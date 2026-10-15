import { describe, expect, test } from 'bun:test'
import type { LightCompletionRequest } from '../model-tiers/light-completion'
import {
  agentAcceptsSuggestions,
  ReplySuggestionLimiter,
  selectSuggestionTarget,
  suggestRepliesAfterTurn,
  type AgentSuggestionState,
  type ReplySuggestionDeps,
  type SuggestionRow,
} from './service'

const at = (seconds: number) => new Date(Date.UTC(2026, 9, 14, 12, 0, seconds))
const human = (overrides: Partial<SuggestionRow> = {}): SuggestionRow => ({
  id: 'h1',
  content: 'The export button crashes when the list is empty.',
  metadata: { source: 'user_chat', sender: { userId: 'u1', name: 'Pat' } },
  createdAt: at(0),
  ...overrides,
})
const agentText = 'Found it: an unchecked first row.\n\nWant me to open a work stream for this?'
const assistant = (overrides: Partial<SuggestionRow> = {}): SuggestionRow => ({
  id: 'a1',
  content: agentText,
  metadata: { executionId: 'e1' },
  createdAt: at(10),
  ...overrides,
})
const idleAgent: AgentSuggestionState = { status: 'idle', hasQuestionData: false, openQuestions: 0, squadId: 'squad-1' }

function fakeDeps(overrides: Partial<ReplySuggestionDeps> = {}) {
  const requests: LightCompletionRequest[] = []
  const saved: Array<{ agentId: string; messageId: string; replies: string[] }> = []
  let reads = 0
  const deps: ReplySuggestionDeps = {
    isEnabled: () => true,
    loadAgent: async () => {
      reads++
      return idleAgent
    },
    loadLatestHuman: async () => {
      reads++
      return human()
    },
    loadRecentAssistant: async () => {
      reads++
      return [assistant()]
    },
    complete: async (request) => {
      requests.push(request)
      return { text: '["Yes, start it", "Not now", "Explain more"]', model: 'anthropic:claude-haiku-4-5:off' }
    },
    save: async (agentId, messageId, replies) => {
      saved.push({ agentId, messageId, replies })
      return true
    },
    ...overrides,
  }
  return { deps, requests, saved, reads: () => reads }
}

describe('selectSuggestionTarget', () => {
  test('the latest agent text after a person’s chat message', () => {
    expect(selectSuggestionTarget(human(), [assistant()])).toEqual({
      messageId: 'a1',
      agentText,
      humanText: 'The export button crashes when the list is empty.',
    })
  })

  test('skips system notices on top of the turn', () => {
    const notice = assistant({
      id: 'sys',
      content: '[System] Compacted.',
      metadata: { isSystem: true },
      createdAt: at(20),
    })
    expect(selectSuggestionTarget(human(), [notice, assistant()])?.messageId).toBe('a1')
  })

  test('no chips for turns started by an inbox delivery, a system message or a non-chat row', () => {
    const inbox = human({ metadata: { source: 'inbox', inboxMessageIds: ['m1'], sender: { name: 'Manager' } } })
    expect(selectSuggestionTarget(inbox, [assistant()])).toBeNull()
    expect(selectSuggestionTarget(human({ metadata: null }), [assistant()])).toBeNull()
    expect(selectSuggestionTarget(null, [assistant()])).toBeNull()
  })

  test('no chips when the person has already written again or a message is still pending', () => {
    expect(selectSuggestionTarget(human({ createdAt: at(30) }), [assistant()])).toBeNull()
    expect(selectSuggestionTarget(human({ pending: true }), [assistant()])).toBeNull()
  })

  test('no chips for a turn that ended without text or already has suggestions', () => {
    expect(selectSuggestionTarget(human(), [assistant({ content: '  ' })])).toBeNull()
    expect(selectSuggestionTarget(human(), [assistant({ metadata: { replySuggestions: ['Yes', 'No'] } })])).toBeNull()
    expect(selectSuggestionTarget(human(), [])).toBeNull()
  })
})

describe('agentAcceptsSuggestions', () => {
  test('only a settled agent with no question card and no open questions', () => {
    expect(agentAcceptsSuggestions(idleAgent)).toBe(true)
    expect(agentAcceptsSuggestions({ ...idleAgent, status: 'waiting-input', hasQuestionData: true })).toBe(false)
    expect(agentAcceptsSuggestions({ ...idleAgent, hasQuestionData: true })).toBe(false)
    expect(agentAcceptsSuggestions({ ...idleAgent, openQuestions: 1 })).toBe(false)
    expect(agentAcceptsSuggestions({ ...idleAgent, status: 'active' })).toBe(false)
    expect(agentAcceptsSuggestions(null)).toBe(false)
  })
})

describe('suggestRepliesAfterTurn', () => {
  test('asks the Lite tier with only the two text excerpts and saves the replies', async () => {
    const { deps, requests, saved } = fakeDeps()
    expect(await suggestRepliesAfterTurn('agent-1', deps, new ReplySuggestionLimiter())).toBe('saved')
    expect(requests).toHaveLength(1)
    expect(requests[0].tier).toBe('lite')
    // Its cost is recorded in the ledger as `lite:reply-suggestions`, attributed to the agent.
    expect(requests[0].purpose).toBe('reply-suggestions')
    expect(requests[0].source).toEqual({ agentId: 'agent-1', squadId: 'squad-1' })
    expect(requests[0].maxTokens).toBeLessThanOrEqual(256)
    expect(requests[0].prompt).toBe(
      '<person_message>\nThe export button crashes when the list is empty.\n</person_message>\n\n' +
        `<agent_message>\n${agentText}\n</agent_message>`
    )
    expect(saved).toEqual([
      { agentId: 'agent-1', messageId: 'a1', replies: ['Yes, start it', 'Not now', 'Explain more'] },
    ])
  })

  test('switched off: no reads, no model call, nothing saved', async () => {
    const { deps, requests, saved, reads } = fakeDeps({ isEnabled: () => false })
    expect(await suggestRepliesAfterTurn('agent-1', deps, new ReplySuggestionLimiter())).toBe('disabled')
    expect(reads()).toBe(0)
    expect(requests).toHaveLength(0)
    expect(saved).toHaveLength(0)
  })

  test('switched off while the model answers: the answer is dropped', async () => {
    let enabled = true
    const { deps, saved } = fakeDeps({
      isEnabled: () => enabled,
      complete: async () => {
        enabled = false
        return { text: '["Yes", "No"]', model: 'm' }
      },
    })
    expect(await suggestRepliesAfterTurn('agent-1', deps, new ReplySuggestionLimiter())).toBe('disabled')
    expect(saved).toHaveLength(0)
  })

  test('no model call when the agent shows a question card or the text asks nothing', async () => {
    const card = fakeDeps({ loadAgent: async () => ({ ...idleAgent, status: 'waiting-input', hasQuestionData: true }) })
    expect(await suggestRepliesAfterTurn('agent-1', card.deps, new ReplySuggestionLimiter())).toBe('agent-not-ready')
    expect(card.requests).toHaveLength(0)

    const status = fakeDeps({
      loadRecentAssistant: async () => [assistant({ content: 'Done. Opened https://example.test/work?ws=42.' })],
    })
    expect(await suggestRepliesAfterTurn('agent-1', status.deps, new ReplySuggestionLimiter())).toBe('no-question')
    expect(status.requests).toHaveLength(0)
  })

  test('no chips for an inbox-driven worker turn', async () => {
    const { deps, requests } = fakeDeps({
      loadLatestHuman: async () => human({ metadata: { source: 'inbox' }, content: 'Flow step: execute' }),
    })
    expect(await suggestRepliesAfterTurn('worker', deps, new ReplySuggestionLimiter())).toBe('no-target')
    expect(requests).toHaveLength(0)
  })

  test('model failures and unusable answers fail closed', async () => {
    const none = fakeDeps({ complete: async () => null })
    expect(await suggestRepliesAfterTurn('a', none.deps, new ReplySuggestionLimiter())).toBe('no-answer')
    const junk = fakeDeps({ complete: async () => ({ text: 'Sure! Yes / No', model: 'm' }) })
    expect(await suggestRepliesAfterTurn('a', junk.deps, new ReplySuggestionLimiter())).toBe('no-replies')
    expect(none.saved).toHaveLength(0)
    expect(junk.saved).toHaveLength(0)
  })

  test('never throws: database and model errors become an outcome', async () => {
    const errors: unknown[] = []
    const db = fakeDeps({
      loadAgent: () => Promise.reject(new Error('db down')),
      onError: (error) => errors.push(error),
    })
    expect(await suggestRepliesAfterTurn('a', db.deps, new ReplySuggestionLimiter())).toBe('error')
    const model = fakeDeps({ complete: () => Promise.reject(new Error('boom')) })
    expect(await suggestRepliesAfterTurn('a', model.deps, new ReplySuggestionLimiter())).toBe('error')
    const setting = fakeDeps({
      isEnabled: () => {
        throw new Error('settings unavailable')
      },
    })
    expect(await suggestRepliesAfterTurn('a', setting.deps, new ReplySuggestionLimiter())).toBe('error')
    expect(errors).toHaveLength(1)
  })

  test('a newer human message makes the save a no-op', async () => {
    const { deps } = fakeDeps({ save: async () => false })
    expect(await suggestRepliesAfterTurn('a', deps, new ReplySuggestionLimiter())).toBe('stale')
  })

  test('one request per agent and a bounded number instance-wide; the slot is released', async () => {
    const limiter = new ReplySuggestionLimiter(2)
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const { deps, requests } = fakeDeps({
      complete: async (request) => {
        requests.push(request)
        await gate
        return { text: '["Yes", "No"]', model: 'm' }
      },
    })
    const first = suggestRepliesAfterTurn('a', deps, limiter)
    expect(await suggestRepliesAfterTurn('a', deps, limiter)).toBe('busy')
    const second = suggestRepliesAfterTurn('b', deps, limiter)
    expect(await suggestRepliesAfterTurn('c', deps, limiter)).toBe('busy')
    release()
    expect(await Promise.all([first, second])).toEqual(['saved', 'saved'])
    expect(await suggestRepliesAfterTurn('c', deps, limiter)).toBe('saved')
  })
})
