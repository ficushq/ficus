import { describe, expect, it } from 'bun:test'
import type { Api, Model } from '@earendil-works/pi-ai'
import { streamSimple as streamAnthropic } from '@earendil-works/pi-ai/api/anthropic-messages'
import { normalizeContext } from '@earendil-works/pi-ai/utils/transcript'
import {
  parseModelSpec,
  parseModelPriorityList,
  resolveAgentModelSpec,
  resolveModelSpec,
  splitModelPriorityList,
  supportsImageInput,
  validateModelSpec,
  validateModelSpecList,
} from './model-spec'

describe('model-spec', () => {
  describe('colon-bearing model ids', () => {
    it('preserves a colon tag in the model id', () =>
      expect(parseModelSpec('ollama:llama3.2:latest')).toEqual({
        provider: 'ollama',
        modelId: 'llama3.2:latest',
        thinkingLevel: undefined,
      }))
    it('parses thinking after a colon-bearing model id', () =>
      expect(parseModelSpec('ollama:llama3.2:latest:high')).toEqual({
        provider: 'ollama',
        modelId: 'llama3.2:latest',
        thinkingLevel: 'high',
      }))
  })

  describe('parseModelSpec', () => {
    it('parses provider:model format', () => {
      expect(parseModelSpec('anthropic:claude-sonnet-4-5')).toEqual({
        provider: 'anthropic',
        modelId: 'claude-sonnet-4-5',
        thinkingLevel: undefined,
      })
    })

    it('parses provider/model format', () => {
      expect(parseModelSpec('anthropic/claude-sonnet-4-5')).toEqual({
        provider: 'anthropic',
        modelId: 'claude-sonnet-4-5',
        thinkingLevel: undefined,
      })
    })

    it('parses optional thinking level from provider:model:thinking format', () => {
      expect(parseModelSpec('openai-codex:gpt-5.6-sol:high')).toEqual({
        provider: 'openai-codex',
        modelId: 'gpt-5.6-sol',
        thinkingLevel: 'high',
      })
    })

    it('parses optional thinking level from provider/model:thinking format', () => {
      expect(parseModelSpec('openai-codex/gpt-5.6-sol:xhigh')).toEqual({
        provider: 'openai-codex',
        modelId: 'gpt-5.6-sol',
        thinkingLevel: 'xhigh',
      })
    })

    it('keeps the vendor slash inside an OpenRouter model id and preserves effort', () => {
      expect(parseModelSpec('openrouter:openai/gpt-5.6-sol:batch:high')).toEqual({
        provider: 'openrouter',
        modelId: 'openai/gpt-5.6-sol:batch',
        thinkingLevel: 'high',
      })
    })

    it('preserves an unrecognized suffix as part of a colon-bearing model id', () => {
      expect(parseModelSpec('openai-codex:gpt-5.6-sol:maximum').modelId).toBe('gpt-5.6-sol:maximum')
    })

    it('rejects model without provider', () => {
      expect(() => parseModelSpec('claude-sonnet-4-5')).toThrow("must be 'provider:model-id'")
    })
  })

  describe('dynamic model catalog validation', () => {
    const model = { id: 'llama3.2:latest', provider: 'local' } as any
    const catalog = {
      getModel: (provider: string, modelId: string) =>
        provider === 'local' && modelId === model.id ? model : undefined,
      getProviders: () => [{ id: 'local' }],
    }
    it('validates a dynamically registered colon-bearing local model', () =>
      expect(validateModelSpec('local:llama3.2:latest', catalog)).toMatchObject({
        provider: 'local',
        modelId: 'llama3.2:latest',
      }))
    it('rejects an unknown model from a dynamic provider', () =>
      expect(() => validateModelSpec('local:missing', catalog)).toThrow("Unknown provider 'local'"))
  })

  describe('validateModelSpec', () => {
    it('validates known provider/model', () => {
      expect(validateModelSpec('anthropic:claude-sonnet-4-5')).toEqual({
        provider: 'anthropic',
        modelId: 'claude-sonnet-4-5',
        thinkingLevel: undefined,
      })
    })

    it('rejects unknown provider', () => {
      expect(() => validateModelSpec('fake:claude-sonnet-4-5')).toThrow("Unknown provider 'fake'")
    })
  })

  describe('supportsImageInput', () => {
    it('returns false for models whose registry input modalities omit image', () => {
      expect(supportsImageInput('zai:glm-5.2')).toBe(false)
    })

    it('returns true for models whose registry input modalities include image', () => {
      expect(supportsImageInput('anthropic:claude-sonnet-4-5')).toBe(true)
    })

    it('uses the selected single model spec rather than other priority-list fallbacks', () => {
      expect(supportsImageInput('zai:glm-5.2:high')).toBe(false)
    })
  })

  describe('OpenRouter backend pinning', () => {
    it('pins the creator backend family and disables OpenRouter-side fallback', () => {
      const { model } = resolveAgentModelSpec('openrouter:anthropic/claude-sonnet-5:high')
      expect((model.compat as any)?.openRouterRouting).toEqual({
        only: ['anthropic'],
        order: ['anthropic'],
        allow_fallbacks: false,
        require_parameters: true,
      })
    })

    it('uses verified endpoint families for Google, DeepSeek, and Xiaomi', () => {
      for (const [spec, endpoint] of [
        ['openrouter:google/gemini-2.5-pro:high', 'google-ai-studio'],
        ['openrouter:deepseek/deepseek-v4-flash', 'streamlake'],
        ['openrouter:xiaomi/mimo-v2.5-pro', 'xiaomi'],
      ] as const) {
        const { model } = resolveAgentModelSpec(spec)
        expect((model.compat as any)?.openRouterRouting).toEqual({
          only: [endpoint],
          order: [endpoint],
          allow_fallbacks: false,
          require_parameters: true,
        })
      }
    })
  })

  describe('Anthropic message threads', () => {
    /** Send one session request and return what reached the wire. */
    async function captureRequest(model: Model<Api>): Promise<{ beta: string; body: Record<string, unknown> }> {
      let captured: { beta: string; body: Record<string, unknown> } | undefined
      const fetch = (async (_url: unknown, init?: RequestInit) => {
        captured = {
          beta: new Headers(init?.headers).get('anthropic-beta') ?? '',
          body: JSON.parse(String(init?.body)),
        }
        return new Response(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'stop' } }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        })
      }) as typeof globalThis.fetch
      await streamAnthropic(
        model as Model<'anthropic-messages'>,
        normalizeContext({ messages: [{ role: 'user', content: 'hi', timestamp: Date.now() }] }),
        { apiKey: 'sk-ant-api03-test', sessionId: crypto.randomUUID(), fetch, maxRetries: 0 }
      ).result()
      if (!captured) throw new Error('no request was sent')
      return captured
    }

    it('turns message threads off for Anthropic agent models', () => {
      const { model } = resolveAgentModelSpec('anthropic:claude-sonnet-4-5')
      expect(model.baseUrl).toContain('api.anthropic.com')
      expect((model.compat as { supportsMessageThreads?: boolean }).supportsMessageThreads).toBe(false)
    })

    it('sends full requests without the thread beta or thread field', async () => {
      // Control: Pi's registry model on api.anthropic.com opts into threads by default.
      const registry = await captureRequest(resolveModelSpec('anthropic:claude-sonnet-4-5'))
      expect(registry.beta).toContain('message-threads')
      expect(registry.body.thread).toEqual({ type: 'create' })

      const { model } = resolveAgentModelSpec('anthropic:claude-sonnet-4-5')
      const request = await captureRequest(model)
      expect(request.beta).not.toContain('message-threads')
      expect(request.body.thread).toBeUndefined()
    })

    it('leaves models on other APIs unchanged', () => {
      const { model } = resolveAgentModelSpec('openai-codex:gpt-5.6-sol')
      expect((model.compat as { supportsMessageThreads?: boolean } | undefined)?.supportsMessageThreads).toBeUndefined()
    })
  })

  describe('resolveModelSpec', () => {
    it('resolves a model with provider + id', () => {
      const model = resolveModelSpec('anthropic:claude-sonnet-4-5')
      expect(model.provider).toBe('anthropic')
      expect(model.id).toBe('claude-sonnet-4-5')
    })

    it('resolves a model with thinking level', () => {
      const result = resolveAgentModelSpec('openai-codex:gpt-5.6-sol:high')
      expect(result.model.provider).toBe('openai-codex')
      expect(result.model.id).toBe('gpt-5.6-sol')
      expect(result.thinkingLevel).toBe('high')
    })
  })
})

describe('model priority lists', () => {
  describe('splitModelPriorityList', () => {
    it('returns a single-element list for a single spec', () => {
      expect(splitModelPriorityList('anthropic:claude-sonnet-4-5')).toEqual(['anthropic:claude-sonnet-4-5'])
    })

    it('splits a comma-separated list and trims whitespace', () => {
      expect(
        splitModelPriorityList(' zai:glm-5.2:high , openai-codex:gpt-5.6-sol:low ,anthropic:claude-sonnet-4-6 ')
      ).toEqual(['zai:glm-5.2:high', 'openai-codex:gpt-5.6-sol:low', 'anthropic:claude-sonnet-4-6'])
    })

    it('drops empty entries', () => {
      expect(splitModelPriorityList('anthropic:claude-sonnet-4-5,, ,')).toEqual(['anthropic:claude-sonnet-4-5'])
    })

    it('rejects an empty/whitespace-only string', () => {
      expect(() => splitModelPriorityList('')).toThrow('non-empty')
      expect(() => splitModelPriorityList('   ')).toThrow('non-empty')
      expect(() => splitModelPriorityList(' ,, ')).toThrow('non-empty')
    })
  })

  describe('parseModelPriorityList', () => {
    it('parses every candidate in the list', () => {
      expect(parseModelPriorityList('zai:glm-5.2:high,anthropic:claude-sonnet-4-6')).toEqual([
        { provider: 'zai', modelId: 'glm-5.2', thinkingLevel: 'high' },
        { provider: 'anthropic', modelId: 'claude-sonnet-4-6', thinkingLevel: undefined },
      ])
    })

    it('treats a single spec as a one-element list (backward compat)', () => {
      expect(parseModelPriorityList('anthropic:claude-sonnet-4-5')).toEqual([
        { provider: 'anthropic', modelId: 'claude-sonnet-4-5', thinkingLevel: undefined },
      ])
    })

    it('propagates parse errors for an invalid candidate', () => {
      expect(() => parseModelPriorityList('anthropic:claude-sonnet-4-5,bad')).toThrow("must be 'provider:model-id'")
    })
  })

  describe('validateModelSpecList', () => {
    it('validates every candidate structurally (provider + model known)', () => {
      const parsed = validateModelSpecList('zai:glm-5.2:high,anthropic:claude-sonnet-4-5')
      expect(parsed).toEqual([
        { provider: 'zai', modelId: 'glm-5.2', thinkingLevel: 'high' },
        { provider: 'anthropic', modelId: 'claude-sonnet-4-5', thinkingLevel: undefined },
      ])
    })

    it('validates a single spec (backward compat)', () => {
      expect(validateModelSpecList('anthropic:claude-sonnet-4-5')).toEqual([
        { provider: 'anthropic', modelId: 'claude-sonnet-4-5', thinkingLevel: undefined },
      ])
    })

    it('rejects when any candidate has an unknown provider', () => {
      expect(() => validateModelSpecList('anthropic:claude-sonnet-4-5,fake:claude-sonnet-4-5')).toThrow(
        "Unknown provider 'fake'"
      )
    })

    it('rejects when any candidate has an unknown model', () => {
      expect(() => validateModelSpecList('anthropic:not-a-real-model')).toThrow("Unknown model 'not-a-real-model'")
    })
  })
})
