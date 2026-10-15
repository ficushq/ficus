import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { Options, Query } from '@anthropic-ai/claude-agent-sdk'
import { completeOnceWithClaudeCode, type ClaudeCodeOneShotRequest, type OneShotQueryFn } from './one-shot'

/**
 * A scripted stand-in for one Claude Code process: yields the given messages, then (unless `hang`)
 * ends. Never runs a real `claude`.
 */
class FakeQuery {
  closed = 0
  prompt: unknown
  options: Options | undefined
  private release: (() => void) | undefined

  constructor(
    private readonly messages: any[],
    private readonly hang = false
  ) {}

  readonly run: OneShotQueryFn = ({ prompt, options }) => {
    this.prompt = prompt
    this.options = options
    return Object.assign(this.messageStream(), {
      close: () => {
        this.closed++
        this.release?.()
      },
    }) as unknown as Query
  }

  private async *messageStream() {
    for (const message of this.messages) yield message
    if (this.hang) await new Promise<void>((resolve) => (this.release = resolve))
  }
}

const success = (result: string) => ({ type: 'result', subtype: 'success', is_error: false, result, session_id: 's' })

function request(overrides: Partial<ClaudeCodeOneShotRequest> = {}): ClaudeCodeOneShotRequest {
  return {
    model: 'claude-haiku-4-5',
    system: 'Suggest replies.',
    prompt: 'Agent asked: deploy now?',
    maxTokens: 200,
    signal: new AbortController().signal,
    ...overrides,
  }
}

const deps = (fake: FakeQuery) => ({
  query: fake.run,
  executable: () => '/usr/local/bin/claude',
  workDir: () => '/tmp/one-shot-test',
})

describe('completeOnceWithClaudeCode', () => {
  let savedKey: string | undefined
  beforeEach(() => {
    savedKey = process.env.ANTHROPIC_API_KEY
    process.env.ANTHROPIC_API_KEY = 'sk-ant-core-secret'
  })
  afterEach(() => {
    if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY
    else process.env.ANTHROPIC_API_KEY = savedKey
  })

  test('asks once with no tools, no settings and no saved session, then closes the query', async () => {
    const fake = new FakeQuery([
      { type: 'system', subtype: 'init', session_id: 's' },
      { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: '["Yes"]' }] } },
      success('  ["Yes","No"]  '),
      // Nothing after the result is read.
      { type: 'result', subtype: 'success', is_error: false, result: 'second' },
    ])
    expect(await completeOnceWithClaudeCode(request(), deps(fake))).toBe('["Yes","No"]')
    expect(fake.prompt).toBe('Agent asked: deploy now?')
    expect(fake.options).toMatchObject({
      model: 'claude-haiku-4-5',
      systemPrompt: 'Suggest replies.',
      pathToClaudeCodeExecutable: '/usr/local/bin/claude',
      cwd: '/tmp/one-shot-test',
      tools: [],
      allowedTools: [],
      permissionMode: 'dontAsk',
      mcpServers: {},
      strictMcpConfig: true,
      settingSources: [],
      thinking: { type: 'disabled' },
      maxTurns: 1,
      persistSession: false,
    })
    expect(fake.options?.resume).toBeUndefined()
    expect(fake.options?.env?.CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBe('200')
    // Claude Code keeps its own sign-in: none of Core's credentials reach the child.
    expect(fake.options?.env?.ANTHROPIC_API_KEY).toBeUndefined()
    expect(fake.closed).toBeGreaterThan(0)
    expect(fake.options?.abortController?.signal.aborted).toBe(true)
  })

  test('thinking is only turned on when asked for', async () => {
    const fake = new FakeQuery([success('ok')])
    await completeOnceWithClaudeCode(request({ thinking: true }), deps(fake))
    expect(fake.options?.thinking).toEqual({ type: 'adaptive' })
  })

  test("reports the result message's token usage, for the inference cost ledger", async () => {
    const fake = new FakeQuery([
      {
        ...success('yes'),
        usage: { input_tokens: 40, output_tokens: 6, cache_read_input_tokens: 3, cache_creation_input_tokens: 2 },
      },
    ])
    const reported: unknown[] = []
    expect(await completeOnceWithClaudeCode(request({ onUsage: (usage) => reported.push(usage) }), deps(fake))).toBe(
      'yes'
    )
    expect(reported).toEqual([{ input: 40, output: 6, cacheRead: 3, cacheWrite: 2 }])
  })

  test('keeps the answer within the output cap', async () => {
    const fake = new FakeQuery([success('x'.repeat(10_000))])
    const answer = await completeOnceWithClaudeCode(request({ maxTokens: 10 }), deps(fake))
    expect(answer).toHaveLength(40)
  })

  test('an empty answer is no answer', async () => {
    const fake = new FakeQuery([success('   ')])
    expect(await completeOnceWithClaudeCode(request(), deps(fake))).toBeNull()
    expect(fake.closed).toBeGreaterThan(0)
  })

  test('an error result throws and closes the query', async () => {
    const fake = new FakeQuery([
      { type: 'result', subtype: 'error_max_turns', is_error: true, errors: ['Reached maximum number of turns'] },
    ])
    await expect(completeOnceWithClaudeCode(request(), deps(fake))).rejects.toThrow('Reached maximum number of turns')
    expect(fake.closed).toBeGreaterThan(0)
  })

  test('an API error (plan limit, sign-in) throws and closes the query', async () => {
    const fake = new FakeQuery(
      [
        {
          type: 'assistant',
          parent_tool_use_id: null,
          error: 'rate_limit',
          message: { content: [{ type: 'text', text: 'Claude usage limit reached' }] },
        },
      ],
      true
    )
    await expect(completeOnceWithClaudeCode(request(), deps(fake))).rejects.toThrow()
    expect(fake.closed).toBeGreaterThan(0)
  })

  test('a process that exits without a result throws and is closed', async () => {
    const fake = new FakeQuery([{ type: 'system', subtype: 'init', session_id: 's' }])
    await expect(completeOnceWithClaudeCode(request(), deps(fake))).rejects.toThrow('without an answer')
    expect(fake.closed).toBeGreaterThan(0)
  })

  test('an abort (the caller or its timeout) closes the hanging query at once', async () => {
    const controller = new AbortController()
    const fake = new FakeQuery([{ type: 'system', subtype: 'init', session_id: 's' }], true)
    const pending = completeOnceWithClaudeCode(request({ signal: controller.signal }), deps(fake))
    await Bun.sleep(0)
    expect(fake.closed).toBe(0)
    controller.abort()
    await expect(pending).rejects.toThrow('aborted')
    expect(fake.closed).toBeGreaterThan(0)
    expect(fake.options?.abortController?.signal.aborted).toBe(true)
  })

  test('starts nothing when already aborted or when Claude Code is not installed', async () => {
    const controller = new AbortController()
    controller.abort()
    const fake = new FakeQuery([success('ok')])
    await expect(completeOnceWithClaudeCode(request({ signal: controller.signal }), deps(fake))).rejects.toThrow()
    await expect(completeOnceWithClaudeCode(request(), { ...deps(fake), executable: () => undefined })).rejects.toThrow(
      'not installed'
    )
    expect(fake.options).toBeUndefined()
  })
})
