import { describe, expect, it } from 'bun:test'
import {
  estimateToolTokens,
  planToolSearch,
  readRecordedPlan,
  resolveSessionPlan,
  supportsMidConversationToolAdditions,
  TOOL_SEARCH_ENTRY_TYPE,
  TOOL_SEARCH_MIN_DEFERRED_TOKENS,
  type DeclaredTool,
  type PlanStore,
  type ToolSearchCapability,
} from './plan'
import { resolveToolSearchCapability } from './capability'

/** A tool whose declaration is about `tokens` estimated tokens. */
function tool(name: string, tokens = 10): DeclaredTool {
  const base = estimateToolTokens({ name, description: '', parameters: {} })
  return { name, description: 'x'.repeat(Math.max(0, (tokens - base) * 4)), parameters: {} }
}

const capable: ToolSearchCapability = { supportsToolAdditions: true, claudeCode: false }
const bigBrowser = [tool('browser_open', 1_500), tool('browser_click', 1_500)]
const core = [tool('bash'), tool('read'), tool('edit')]

describe('planToolSearch', () => {
  it('hides deferrable tools above the threshold on a capable model', () => {
    const plan = planToolSearch({ tools: [...core, ...bigBrowser], capability: capable })
    expect(plan.mode).toBe('search')
    expect(plan.hidden).toEqual(['browser_click', 'browser_open'])
  })

  it('declares everything when the deferrable tools are under the threshold', () => {
    const small = [tool('browser_open', 100), tool('ast_symbols', 100)]
    const plan = planToolSearch({ tools: [...core, ...small], capability: capable })
    expect(plan).toMatchObject({ mode: 'direct', hidden: [] })
    expect(plan.reason).toContain(`under ${TOOL_SEARCH_MIN_DEFERRED_TOKENS}`)
  })

  it('skips the size check with search: on', () => {
    const plan = planToolSearch({
      tools: [...core, tool('browser_open', 100)],
      policy: { search: 'on' },
      capability: capable,
    })
    expect(plan).toMatchObject({ mode: 'search', hidden: ['browser_open'] })
  })

  it('declares everything with search: off', () => {
    const plan = planToolSearch({ tools: [...core, ...bigBrowser], policy: { search: 'off' }, capability: capable })
    expect(plan).toMatchObject({ mode: 'direct', hidden: [] })
  })

  it('declares everything when the model cannot add tools mid-conversation', () => {
    const plan = planToolSearch({
      tools: [...core, ...bigBrowser],
      capability: { supportsToolAdditions: false, claudeCode: false },
    })
    expect(plan).toMatchObject({ mode: 'direct', hidden: [] })
  })

  it("follows the agent type's labels", () => {
    const plan = planToolSearch({
      tools: [...core, ...bigBrowser, tool('webfetch', 1_000)],
      policy: { direct: ['browser_click'], deferred: ['webfetch'] },
      capability: capable,
    })
    expect(plan.hidden).toEqual(['browser_open', 'webfetch'])
  })

  it('leaves Claude Code sessions to Claude Code tool search and never plans pi search for them', () => {
    const plan = planToolSearch({
      tools: [...core, ...bigBrowser],
      capability: { supportsToolAdditions: false, claudeCode: true },
    })
    expect(plan).toMatchObject({ mode: 'claude-code', hidden: ['browser_click', 'browser_open'] })
    expect(
      planToolSearch({
        tools: [...core, ...bigBrowser],
        policy: { search: 'off' },
        capability: { ...capable, claudeCode: true },
      }).mode
    ).toBe('direct')
  })
})

describe('supportsMidConversationToolAdditions', () => {
  it('matches the transports that send tool additions in place', () => {
    const check = (api: string, compat: Record<string, unknown>) =>
      supportsMidConversationToolAdditions({ api, compat } as never)
    expect(
      check('anthropic-messages', { supportsMidConvoSystemMessages: true, supportsMidConvoToolChanges: true })
    ).toBe(true)
    expect(check('anthropic-messages', { supportsMidConvoSystemMessages: true })).toBe(false)
    expect(check('openai-codex-responses', { supportsToolSearch: true })).toBe(true)
    expect(check('openai-responses', { supportsMidConvoSystemMessages: true, supportsAdditionalTools: true })).toBe(
      true
    )
    expect(check('openai-responses', { supportsAdditionalTools: true })).toBe(false)
    expect(
      check('openai-completions', { supportsMidConvoSystemMessages: true, supportsMidConvoToolAdditions: true })
    ).toBe(true)
    expect(check('openai-completions', { supportsMidConvoSystemMessages: true })).toBe(false)
    expect(check('google-generative-ai', { supportsMidConvoSystemMessages: true })).toBe(false)
  })

  it("reflects pi's catalog for the models of Ficus's tier chains", async () => {
    const { getModel } = await import('@earendil-works/pi-ai/compat')
    const supports = (provider: string, id: string) => {
      const model = getModel(provider as never, id as never)
      expect(model).toBeDefined()
      return supportsMidConversationToolAdditions(model!)
    }
    expect(supports('anthropic', 'claude-opus-5-5')).toBe(true)
    expect(supports('anthropic', 'claude-sonnet-5-5')).toBe(true)
    expect(supports('openai-codex', 'gpt-6.2-sol')).toBe(true)
    expect(supports('openai-codex', 'gpt-6-luna')).toBe(true)
    // Failover only: tool search keeps working there, each load costs a cache miss.
    expect(supports('zai', 'glm-5.3')).toBe(false)
    expect(supports('anthropic', 'claude-opus-4-5')).toBe(false)
  })

  it('marks an Anthropic session with an enabled Claude Code account as Claude Code', () => {
    const model = { api: 'anthropic-messages', provider: 'anthropic', compat: {} } as never
    expect(resolveToolSearchCapability({ model, claudeCodeEnabledFor: (p) => p === 'anthropic' }).claudeCode).toBe(true)
    expect(resolveToolSearchCapability({ model, claudeCodeEnabledFor: () => false }).claudeCode).toBe(false)
  })
})

function memoryStore(entries: unknown[] = []): PlanStore & { entries: unknown[] } {
  return {
    entries,
    getEntries: () => entries,
    appendCustomEntry(customType, data) {
      entries.push({ type: 'custom', customType, data })
      return String(entries.length)
    },
  }
}

describe('resolveSessionPlan', () => {
  const searchPlan = { mode: 'search' as const, hidden: ['browser_click', 'browser_open'], reason: 'test' }

  it('decides once and records the decision in the session file', () => {
    const store = memoryStore()
    let decisions = 0
    const decide = () => {
      decisions++
      return searchPlan
    }
    const names = ['bash', 'browser_click', 'browser_open']
    expect(resolveSessionPlan(store, decide, names).hidden).toEqual(searchPlan.hidden)
    // A later turn (or a resume) reads the recorded plan, even if a new decision would differ.
    const later = resolveSessionPlan(store, () => ({ mode: 'direct', hidden: [], reason: 'changed' }), names)
    expect(later).toMatchObject({ mode: 'search', hidden: searchPlan.hidden })
    expect(decisions).toBe(1)
    expect(
      store.entries.filter((entry) => (entry as { customType?: string }).customType === TOOL_SEARCH_ENTRY_TYPE)
    ).toHaveLength(1)
  })

  it('keeps every tool declared in a session that started before tool search', () => {
    const store = memoryStore([{ type: 'message', message: { role: 'user', content: 'hi' } }])
    const plan = resolveSessionPlan(store, () => searchPlan, ['bash', 'browser_open'])
    expect(plan.mode).toBe('direct')
    expect(readRecordedPlan(store)?.mode).toBe('direct')
  })

  it('drops recorded hidden tools the session no longer has', () => {
    const store = memoryStore()
    resolveSessionPlan(store, () => searchPlan, ['bash', 'browser_click', 'browser_open'])
    expect(resolveSessionPlan(store, () => searchPlan, ['bash', 'browser_open']).hidden).toEqual(['browser_open'])
  })

  it('ignores malformed entries', () => {
    const store = memoryStore([{ type: 'custom', customType: TOOL_SEARCH_ENTRY_TYPE, data: { version: 2 } }])
    expect(readRecordedPlan(store)).toBeUndefined()
  })
})
