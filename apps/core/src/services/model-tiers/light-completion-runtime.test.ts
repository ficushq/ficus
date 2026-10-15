import { describe, expect, test } from 'bun:test'
import { CLAUDE_CODE_FLAG } from '../agent/claude-code/account'
import type { ClaudeCodeOneShotRequest } from '../agent/claude-code/one-shot'
import { completeLight, type LightCompletionCall, type LightCompletionDeps } from './light-completion'
import {
  CLAUDE_CODE_LIGHT_COMPLETION_TIMEOUT_MS,
  candidateTimeoutWithRuntime,
  completeWithRuntime,
  type LightCompletionRuntimeDeps,
} from './light-completion-runtime'

const HAIKU = 'anthropic:claude-haiku-4-5:off'
const LUNA = 'openai-codex:gpt-6-luna:off'
const claudeCodeAuth = { auth: {}, env: { [CLAUDE_CODE_FLAG]: '1' }, source: 'Claude Code' }
const apiKeyAuth = { auth: { apiKey: 'sk-test' } }

/** A stand-in model runtime: built-in models, a chosen auth per provider, and a recorded API call. */
function fakeRuntime(authByProvider: Record<string, unknown>, apiAnswer = 'from the API') {
  const apiCalls: string[] = []
  const claudeCodeCalls: ClaudeCodeOneShotRequest[] = []
  const runtime = {
    getModel: () => undefined,
    getProviders: () => [],
    getAuth: async (model: { provider: string }) => authByProvider[model.provider],
    completeSimple: async (model: { id: string }) => {
      apiCalls.push(model.id)
      return { stopReason: 'stop', content: [{ type: 'text', text: apiAnswer }] }
    },
  }
  const deps: LightCompletionRuntimeDeps = {
    runtime: async () => runtime as any,
    claudeCode: async (request) => {
      claudeCodeCalls.push(request)
      return 'from Claude Code'
    },
  }
  return { deps, apiCalls, claudeCodeCalls }
}

const call = (): LightCompletionCall => ({
  system: 'sys',
  prompt: 'hello',
  maxTokens: 200,
  timeoutMs: 6_000,
  signal: new AbortController().signal,
})

describe('light completions through the model runtime', () => {
  test('a Claude Code account answers through the one-shot call, with the request and its signal', async () => {
    const fake = fakeRuntime({ anthropic: claudeCodeAuth })
    const request = call()
    expect(await completeWithRuntime(HAIKU, request, fake.deps)).toBe('from Claude Code')
    expect(fake.apiCalls).toEqual([])
    expect(fake.claudeCodeCalls).toEqual([
      {
        model: 'claude-haiku-4-5',
        system: 'sys',
        prompt: 'hello',
        maxTokens: 200,
        signal: request.signal,
        thinking: false,
      },
    ])
  })

  test('any other account still uses the provider API, and no auth means no answer', async () => {
    const fake = fakeRuntime({ anthropic: apiKeyAuth })
    expect(await completeWithRuntime(HAIKU, call(), fake.deps)).toBe('from the API')
    expect(fake.claudeCodeCalls).toEqual([])
    expect(await completeWithRuntime(LUNA, call(), fake.deps)).toBeNull()
    expect(fake.apiCalls).toEqual(['claude-haiku-4-5'])
  })

  test('only a Claude Code candidate gets the longer wait', async () => {
    const fake = fakeRuntime({ anthropic: claudeCodeAuth, 'openai-codex': apiKeyAuth })
    expect(await candidateTimeoutWithRuntime(HAIKU, 6_000, fake.deps)).toBe(CLAUDE_CODE_LIGHT_COMPLETION_TIMEOUT_MS)
    expect(await candidateTimeoutWithRuntime(LUNA, 6_000, fake.deps)).toBe(6_000)
    // A request that already allows longer keeps its own wait.
    expect(await candidateTimeoutWithRuntime(HAIKU, 20_000, fake.deps)).toBe(20_000)
  })

  test('a failed Claude Code call falls back to the next candidate', async () => {
    const fake = fakeRuntime({ anthropic: claudeCodeAuth, 'openai-codex': apiKeyAuth })
    fake.deps.claudeCode = async () => {
      throw new Error('Claude Code sign-in failed')
    }
    const timeouts: number[] = []
    const errors: string[] = []
    const deps: LightCompletionDeps = {
      tierChain: async () => `${HAIKU},${LUNA}`,
      usableCandidates: (chain) => chain.split(','),
      complete: (spec, request) => {
        timeouts.push(request.timeoutMs)
        return completeWithRuntime(spec, request, fake.deps)
      },
      candidateTimeoutMs: (spec, timeoutMs) => candidateTimeoutWithRuntime(spec, timeoutMs, fake.deps),
      onCandidateError: (spec) => errors.push(spec),
    }
    const result = await completeLight({ tier: 'lite', system: 'sys', prompt: 'hello', timeoutMs: 6_000 }, deps)
    expect(result).toEqual({ text: 'from the API', model: LUNA })
    expect(errors).toEqual([HAIKU])
    expect(timeouts[0]).toBe(CLAUDE_CODE_LIGHT_COMPLETION_TIMEOUT_MS)
    expect(timeouts[1]).toBeLessThanOrEqual(6_000)
  })
})
