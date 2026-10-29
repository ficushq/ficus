import { describe, expect, it } from 'bun:test'
import {
  ModelSelectionError,
  selectModelSpec,
  selectModelSpecWithSwitchBack,
  type SelectModelDeps,
  type SwitchBackDeps,
} from './select-model'

// Known-good provider/model ids from the Pi registry.
const ZAI = 'zai:glm-5-turbo'
const ANTHROPIC = 'anthropic:claude-haiku-4-5'
const OPENAI_CODEX = 'openai-codex:gpt-5.6-sol'
const UNKNOWN_PROVIDER = 'fake:glm-5-turbo'
const UNKNOWN_MODEL = 'zai:not-a-real-model'

function deps(
  opts: {
    configured?: (p: string) => boolean
    disabled?: (p: string) => boolean
    healthy?: (p: string) => boolean
  } = {}
): SelectModelDeps {
  return {
    isProviderConfigured: opts.configured ?? (() => true),
    isProviderDisabled: opts.disabled ?? (() => false),
    isProviderHealthy: opts.healthy,
  }
}

function sbDeps(
  opts: {
    configured?: (p: string) => boolean
    disabled?: (p: string) => boolean
    healthy?: (p: string) => boolean
    stable?: (p: string) => boolean
  } = {}
): SwitchBackDeps {
  return {
    isProviderConfigured: opts.configured ?? (() => true),
    isProviderDisabled: opts.disabled ?? (() => false),
    isProviderHealthy: opts.healthy,
    isSwitchBackStable: opts.stable,
  }
}

describe('selectModelSpec', () => {
  it('passes through a single usable spec', () => {
    const result = selectModelSpec(ZAI, deps())
    expect(result.selected).toBe(ZAI)
    expect(result.candidates).toHaveLength(1)
    expect(result.candidates[0]).toMatchObject({ spec: ZAI, provider: 'zai', usable: true })
  })

  it('picks the first usable candidate', () => {
    const result = selectModelSpec(`${ZAI},${ANTHROPIC},${OPENAI_CODEX}`, deps())
    expect(result.selected).toBe(ZAI)
    expect(result.candidates).toHaveLength(1)
  })

  it('skips a candidate whose provider is not authenticated and picks the next', () => {
    const result = selectModelSpec(`${ZAI},${ANTHROPIC}`, deps({ configured: (p) => p !== 'zai' }))
    expect(result.selected).toBe(ANTHROPIC)
    expect(result.candidates).toHaveLength(2)
    expect(result.candidates[0]).toMatchObject({ spec: ZAI, usable: false, reason: 'auth-missing' })
    expect(result.candidates[1]).toMatchObject({ spec: ANTHROPIC, usable: true })
  })

  it('skips a disabled provider even when configured', () => {
    const result = selectModelSpec(`${ZAI},${ANTHROPIC}`, deps({ disabled: (p) => p === 'zai' }))
    expect(result.selected).toBe(ANTHROPIC)
    expect(result.candidates[0]).toMatchObject({ spec: ZAI, usable: false, reason: 'provider-disabled' })
  })

  it('reuses a re-enabled provider (not in disabled set)', () => {
    const result = selectModelSpec(`${ZAI},${ANTHROPIC}`, deps({ disabled: (p) => p === 'anthropic' }))
    expect(result.selected).toBe(ZAI)
  })

  it('skips unknown providers', () => {
    const result = selectModelSpec(`${UNKNOWN_PROVIDER},${ZAI}`, deps())
    expect(result.selected).toBe(ZAI)
    expect(result.candidates[0]).toMatchObject({ spec: UNKNOWN_PROVIDER, usable: false, reason: 'unknown-provider' })
  })

  it('skips unknown models for a known provider', () => {
    const result = selectModelSpec(`${UNKNOWN_MODEL},${ZAI}`, deps())
    expect(result.selected).toBe(ZAI)
    expect(result.candidates[0]).toMatchObject({ spec: UNKNOWN_MODEL, usable: false, reason: 'unknown-model' })
  })

  it('skips an unparseable spec', () => {
    const result = selectModelSpec(`bad-spec,${ZAI}`, deps())
    expect(result.selected).toBe(ZAI)
    expect(result.candidates[0]).toMatchObject({ spec: 'bad-spec', usable: false, reason: 'parse-error' })
  })

  it('throws ModelSelectionError listing every candidate when none are usable', () => {
    let err: ModelSelectionError | null = null
    try {
      // unknown-provider, auth-missing (zai configured=false), provider-disabled (anthropic)
      selectModelSpec(
        `${UNKNOWN_PROVIDER},${ZAI},${ANTHROPIC}`,
        deps({ configured: (p) => p !== 'zai', disabled: (p) => p === 'anthropic' })
      )
    } catch (e) {
      err = e as ModelSelectionError
    }
    expect(err).toBeInstanceOf(ModelSelectionError)
    expect(err!.candidates).toHaveLength(3)
    expect(err!.candidates.map((c) => c.reason)).toEqual(['unknown-provider', 'auth-missing', 'provider-disabled'])
    // The message mentions every attempted spec and its reason.
    const message = err!.message
    expect(message).toContain(UNKNOWN_PROVIDER)
    expect(message).toContain(ZAI)
    expect(message).toContain(ANTHROPIC)
    expect(message).toContain('unknown provider')
    expect(message).toContain('not authenticated')
    expect(message).toContain('disabled')
  })

  it('treats a single spec as a one-element list (backward compat)', () => {
    const result = selectModelSpec(ZAI, deps())
    expect(result.candidates).toHaveLength(1)
  })

  it('skips an exhausted provider and picks the next healthy candidate', () => {
    const result = selectModelSpec(`${ZAI},${ANTHROPIC}`, deps({ healthy: (p) => p !== 'zai' }))
    expect(result.selected).toBe(ANTHROPIC)
    expect(result.candidates).toHaveLength(2)
    expect(result.candidates[0]).toMatchObject({ spec: ZAI, usable: false, reason: 'provider-exhausted' })
    expect(result.candidates[1]).toMatchObject({ spec: ANTHROPIC, usable: true })
  })

  it('isProviderHealthy is optional — omitting it preserves prior behavior', () => {
    // No healthy predicate: a single configured spec is selected as before.
    const result = selectModelSpec(ZAI, deps())
    expect(result.selected).toBe(ZAI)
    expect(result.candidates[0]).toMatchObject({ spec: ZAI, usable: true })
  })

  it('throws ModelSelectionError listing provider-exhausted when all candidates are exhausted', () => {
    let err: ModelSelectionError | null = null
    try {
      selectModelSpec(`${ZAI},${ANTHROPIC}`, deps({ healthy: () => false }))
    } catch (e) {
      err = e as ModelSelectionError
    }
    expect(err).toBeInstanceOf(ModelSelectionError)
    expect(err!.candidates).toHaveLength(2)
    expect(err!.candidates.map((c) => c.reason)).toEqual(['provider-exhausted', 'provider-exhausted'])
    expect(err!.message).toContain('exhausted (in cooldown)')
  })

  it('still skips exhausted providers even when a later candidate is also exhausted', () => {
    // zai exhausted, anthropic exhausted, openai-codex healthy → select codex.
    const result = selectModelSpec(
      `${ZAI},${ANTHROPIC},${OPENAI_CODEX}`,
      deps({
        healthy: (p) => p === 'openai-codex',
      })
    )
    expect(result.selected).toBe(OPENAI_CODEX)
    expect(result.candidates.map((c) => c.reason)).toEqual(['provider-exhausted', 'provider-exhausted', undefined])
  })
})

describe('selectModelSpecWithSwitchBack', () => {
  const LIST = `${ANTHROPIC},${ZAI}` // anthropic is higher priority

  it('switches back to a strictly-higher recovered+stable candidate', () => {
    const r = selectModelSpecWithSwitchBack(LIST, ZAI, sbDeps({ stable: (p) => p === 'anthropic' }))
    expect(r.selected).toBe(ANTHROPIC)
    expect(r.switchedBack).toEqual({ from: ZAI, to: ANTHROPIC, reason: 'higher-priority-recovered' })
  })

  it('does NOT switch back within the stability window (anti-flap)', () => {
    const r = selectModelSpecWithSwitchBack(LIST, ZAI, sbDeps({ stable: () => false }))
    expect(r.selected).toBe(ZAI)
    expect(r.switchedBack).toBeUndefined()
  })

  it('does not switch back while the higher provider is still exhausted', () => {
    const r = selectModelSpecWithSwitchBack(LIST, ZAI, sbDeps({ healthy: (p) => p === 'zai', stable: () => true }))
    expect(r.selected).toBe(ZAI)
    expect(r.switchedBack).toBeUndefined()
  })

  it('does not switch back when the higher provider is unconfigured', () => {
    const r = selectModelSpecWithSwitchBack(
      LIST,
      ZAI,
      sbDeps({ configured: (p) => p !== 'anthropic', stable: () => true })
    )
    expect(r.selected).toBe(ZAI)
  })

  it('does not switch back when the higher provider is disabled', () => {
    const r = selectModelSpecWithSwitchBack(
      LIST,
      ZAI,
      sbDeps({ disabled: (p) => p === 'anthropic', stable: () => true })
    )
    expect(r.selected).toBe(ZAI)
  })

  it('does not switch when current is already the highest usable', () => {
    const r = selectModelSpecWithSwitchBack(LIST, ANTHROPIC, sbDeps({ stable: () => true }))
    expect(r.selected).toBe(ANTHROPIC)
    expect(r.switchedBack).toBeUndefined()
  })

  it('never switches downward/sideways', () => {
    const r = selectModelSpecWithSwitchBack(LIST, ANTHROPIC, sbDeps({ stable: () => true }))
    expect(r.selected).toBe(ANTHROPIC)
    expect(r.switchedBack).toBeUndefined()
  })

  it('falls through to eager selection when current is no longer usable', () => {
    const r = selectModelSpecWithSwitchBack(
      LIST,
      ANTHROPIC,
      sbDeps({ healthy: (p) => p === 'zai', stable: () => true })
    )
    expect(r.selected).toBe(ZAI)
    expect(r.switchedBack).toBeUndefined()
  })

  it('uses normal eager selection when no currentSpec (fresh agent)', () => {
    const r = selectModelSpecWithSwitchBack(LIST, undefined, sbDeps({ stable: () => true }))
    expect(r.selected).toBe(ANTHROPIC)
    expect(r.switchedBack).toBeUndefined()
  })

  it('throws ModelSelectionError when nothing is usable', () => {
    expect(() => selectModelSpecWithSwitchBack(LIST, ZAI, sbDeps({ healthy: () => false }))).toThrow(
      ModelSelectionError
    )
  })

  it('picks the highest stable upgrade among multiple higher candidates', () => {
    const LIST3 = `${ANTHROPIC},${ZAI},${OPENAI_CODEX}`
    const r = selectModelSpecWithSwitchBack(LIST3, OPENAI_CODEX, sbDeps({ stable: (p) => p === 'anthropic' }))
    expect(r.selected).toBe(ANTHROPIC)
  })

  it('matches current by provider:modelId ignoring thinking-level suffix', () => {
    // current has a thinking-level suffix not present in the list
    const r = selectModelSpecWithSwitchBack(LIST, `${ANTHROPIC}:high`, sbDeps({ stable: () => true }))
    expect(r.selected).toBe(ANTHROPIC)
    expect(r.switchedBack).toBeUndefined()
  })
})

describe('window-aware preference', () => {
  const windows: Record<string, number> = { small: 272_000, large: 1_000_000 }
  const allUsable = {
    modelCatalog: {
      getProviders: () => [{ id: 'test-window' }],
      getModel: (provider: string, id: string) =>
        provider === 'test-window' && windows[id] ? { id, provider, contextWindow: windows[id] } : undefined,
    },
    isProviderConfigured: () => true,
    isProviderDisabled: () => false,
    isProviderHealthy: () => true,
  }

  it('prefers a later candidate whose window fits the current context', () => {
    // Fixed windows test selection policy independently of the evolving provider catalog.
    const sel = selectModelSpec('test-window:small,test-window:large', {
      ...allUsable,
      preferContextTokens: 500_000,
    })
    expect(sel.selected).toBe('test-window:large')
  })

  it('keeps first-usable when the context fits it', () => {
    const sel = selectModelSpec('test-window:small,test-window:large', {
      ...allUsable,
      preferContextTokens: 100_000,
    })
    expect(sel.selected).toBe('test-window:small')
  })

  it('falls back to first-usable when nothing fits', () => {
    const sel = selectModelSpec('test-window:small,test-window:large', {
      ...allUsable,
      preferContextTokens: 5_000_000,
    })
    expect(sel.selected).toBe('test-window:small')
  })

  it('is inert when preferContextTokens is absent', () => {
    const sel = selectModelSpec('test-window:small,test-window:large', { ...allUsable })
    expect(sel.selected).toBe('test-window:small')
  })
})

describe('dynamic compatible provider selection', () => {
  it('selects a registered local runtime model', () => {
    const model = { id: 'llama3.2:latest', provider: 'local' }
    expect(
      selectModelSpec('local:llama3.2:latest', {
        isProviderConfigured: () => true,
        isProviderDisabled: () => false,
        modelCatalog: {
          getProviders: () => [{ id: 'local' }],
          getModel: (provider, id) => (provider === 'local' && id === model.id ? (model as any) : undefined),
        },
      }).selected
    ).toBe('local:llama3.2:latest')
  })
})
