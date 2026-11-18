import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ModelRuntime, SessionManager } from '@earendil-works/pi-coding-agent'
import type { Api, Context, Model, AssistantMessage } from '@earendil-works/pi-ai'
import { AssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream'
import { normalizeContext } from '@earendil-works/pi-ai/utils/transcript'
import { stream as codex } from '@earendil-works/pi-ai/api/openai-codex-responses'
import { stream as responses } from '@earendil-works/pi-ai/api/openai-responses'
import { protectResponsesToolNames, responsesToolNameStream } from './responses-tool-names'

const model: Model<Api> = {
  id: 'test',
  name: 'test',
  api: 'openai-codex-responses',
  provider: 'openai-codex',
  baseUrl: 'https://example.invalid',
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 10000,
  maxTokens: 1000,
  compat: { supportsMidConvoSystemMessages: true, supportsToolSearch: true },
}
const tool = (name: string) => ({ name, description: 'Example', parameters: { type: 'object', properties: {} } })
const invalid = 'mcp:example/read tool'
const context = (): Context => ({
  messages: [
    { role: 'system', content: 'Initial', toolsAdded: [tool('valid.name-1')], timestamp: 1 },
    { role: 'user', content: 'Continue', timestamp: 2 },
    { role: 'system', content: '', toolsAdded: [tool(invalid)], timestamp: 3 },
  ],
})
const validName = /^[a-zA-Z0-9_.-]+$/

const assistantMessage = (): AssistantMessage => ({
  role: 'assistant',
  api: model.api,
  provider: model.provider,
  model: model.id,
  content: [],
  stopReason: 'toolUse',
  timestamp: 1,
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
})

async function payload(api: typeof codex | typeof responses, selected = model, input = context()) {
  let captured: any
  const stream = responsesToolNameStream((m, c, o) => api(m as never, normalizeContext(c), o))
  await stream(selected, input, {
    apiKey: `x.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'test' } })).toString('base64url')}.x`,
    onPayload(body) {
      captured = body
      throw new Error('Captured before network')
    },
  }).result()
  expect(captured).toBeDefined()
  return captured
}

describe('Responses tool names at the runtime boundary', () => {
  test('actual Codex synthetic tool-search output and replay use safe names without changing history', async () => {
    const history = context()
    const before = JSON.stringify(history)
    const first = await payload(codex, model, history)
    const outputs = first.input.filter((item: any) => item.type === 'tool_search_output')
    expect(outputs.length).toBeGreaterThan(0)
    const names = outputs.flatMap((item: any) => item.tools.map((t: any) => t.name))
    expect(first.tools.map((tool: any) => tool.name)).toContain('valid.name-1')
    expect(names.every((name: string) => validName.test(name))).toBe(true)
    expect(JSON.stringify(history)).toBe(before)
    const dir = mkdtempSync(join(tmpdir(), 'responses-name-replay-'))
    try {
      const session = SessionManager.create(dir, dir)
      for (const message of history.messages) session.appendMessage(message)
      const reopened = SessionManager.open(session.getSessionFile()!)
      expect(
        await payload(codex, model, { messages: reopened.buildSessionContext().messages as Context['messages'] })
      ).toEqual(first)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('other Responses providers protect additional_tools and top-level declarations too', async () => {
    const selected = {
      ...model,
      api: 'openai-responses',
      provider: 'openai',
      compat: { ...model.compat, supportsAdditionalTools: true },
    } as Model<Api>
    const body = await payload(responses, selected)
    expect(
      body.input
        .filter((item: any) => item.type === 'additional_tools')
        .flatMap((item: any) => item.tools)
        .every((t: any) => validName.test(t.name))
    ).toBe(true)
    const topLevel = await payload(responses, { ...selected, compat: {} }, { messages: [], tools: [tool(invalid)] })
    expect(validName.test(topLevel.tools[0].name)).toBe(true)
  })

  test('declarations, history calls and results share aliases; streamed calls restore original dispatch names', async () => {
    let seen: Context | undefined
    const output = assistantMessage()
    const input = context()
    input.messages.push({
      ...output,
      content: [{ type: 'toolCall', id: 'call', name: invalid, arguments: { name: invalid } }],
    })
    input.messages.push({
      role: 'toolResult',
      toolCallId: 'call',
      toolName: invalid,
      content: [{ type: 'text', text: invalid }],
      isError: false,
      timestamp: 4,
    })
    input.messages.push({ role: 'system', content: '', toolsRemoved: [{ name: invalid }], timestamp: 5 })
    const stream = responsesToolNameStream((_m, c) => {
      seen = c
      const name = (c.messages[2] as any).toolsAdded[0].name
      const call = { type: 'toolCall' as const, id: 'new', name, arguments: { name: invalid }, namespace: 'example' }
      output.content = [call]
      const result = new AssistantMessageEventStream()
      result.push({ type: 'toolcall_start', contentIndex: 0, partial: output })
      result.push({ type: 'toolcall_end', contentIndex: 0, toolCall: call, partial: output })
      result.push({ type: 'done', reason: 'toolUse', message: output })
      result.end()
      return result
    })(model, input)
    for await (const event of stream) {
      if ('partial' in event) expect((event.partial.content[0] as any).name).toBe(invalid)
      if (event.type === 'toolcall_end') expect(event.toolCall.name).toBe(invalid)
    }
    expect((await stream.result()).content[0]).toMatchObject({
      name: invalid,
      arguments: { name: invalid },
      namespace: 'example',
    })
    const alias = (seen!.messages[2] as any).toolsAdded[0].name
    expect(validName.test(alias)).toBe(true)
    expect(alias).not.toBe(invalid)
    expect((seen!.messages[3] as any).content[0].name).toBe(alias)
    expect((seen!.messages[4] as any).toolName).toBe(alias)
    expect((seen!.messages[4] as any).content[0].text).toBe(invalid)
    expect((output.content[0] as any).name).toBe(alias)
    expect((seen!.messages[5] as any).toolsRemoved[0].name).toBe(alias)
    const body = await payload(codex, model, input)
    expect(body.input.find((item: any) => item.type === 'function_call').name).toBe(alias)
    expect(body.input.find((item: any) => item.type === 'function_call_output').output).toBe(invalid)
  })

  test.each(['error', 'aborted'] as const)('restores partial calls on terminal %s events', async (reason) => {
    const stream = responsesToolNameStream((_m, c) => {
      const output = assistantMessage()
      output.stopReason = reason
      output.content = [
        { type: 'toolCall', id: 'call', name: (c.messages[2] as any).toolsAdded[0].name, arguments: {} },
      ]
      const source = new AssistantMessageEventStream()
      source.push({ type: 'error', reason, error: output })
      source.end()
      return source
    })(model, context())
    for await (const event of stream) {
      expect(event.type).toBe('error')
      if (event.type === 'error') expect((event.error.content[0] as any).name).toBe(invalid)
    }
    expect((await stream.result()).content[0]).toMatchObject({ name: invalid })
  })

  test('aliases cannot shadow valid names, even names equal to a generated alias', async () => {
    let alias = ''
    const capture = responsesToolNameStream((_m, c) => {
      alias = (c.messages[2] as any).toolsAdded[0].name
      const names = [
        ...(c.messages[0] as any).toolsAdded.map((t: any) => t.name),
        ...(c.messages[2] as any).toolsAdded.map((t: any) => t.name),
      ]
      expect(new Set(names).size).toBe(names.length)
      expect(names.every((name: string) => validName.test(name))).toBe(true)
      const result = new AssistantMessageEventStream()
      result.end({ content: [] } as unknown as AssistantMessage)
      return result
    })
    await capture(model, context()).result()
    const reserved = alias
    const input = context()
    ;(input.messages[0] as any).toolsAdded.push(tool(reserved), tool('mcp/example/read tool'))
    await capture(model, input).result()
    expect(alias).not.toBe(reserved)
    expect(validName.test(alias)).toBe(true)
    expect((input.messages[0] as any).toolsAdded[1].name).toBe(reserved)
  })

  test('runtime installation is idempotent and both completion entry points adapt tool names', async () => {
    const runtime = await ModelRuntime.create({ refreshOnCreate: false, modelsPath: null })
    const seen: Context[] = []
    // A local transport avoids auth and network while the real runtime completion methods
    // exercise dispatch through its replaceable public stream entry points.
    const transport = (_m: Model<Api>, c: Context) => {
      seen.push(c)
      const result = new AssistantMessageEventStream()
      result.end({ content: [] } as unknown as AssistantMessage)
      return result
    }
    runtime.stream = transport
    runtime.streamSimple = transport
    protectResponsesToolNames(runtime)
    const once = runtime.stream
    protectResponsesToolNames(runtime)
    expect(runtime.stream).toBe(once)
    await runtime.complete(model, context())
    await runtime.completeSimple(model, context())
    expect(seen).toHaveLength(2)
    for (const c of seen) expect(validName.test((c.messages[2] as any).toolsAdded[0].name)).toBe(true)
  })

  test.each(['trailing_newline\n', 'carriage_return\r', 'unicode_é', 'zero_width_\u200b', ''])(
    'encodes the entire invalid name %j',
    async (name) => {
      const body = await payload(codex, { ...model, compat: {} }, { messages: [], tools: [tool(name)] })
      expect(body.tools[0].name).not.toBe(name)
      expect(body.tools[0].name.length).toBeGreaterThan(0)
      expect(/[^a-zA-Z0-9_.-]/.test(body.tools[0].name)).toBe(false)
    }
  )

  test('valid tool names and non-Responses providers pass through untouched', () => {
    const source = new AssistantMessageEventStream()
    const input: Context = { tools: [tool('mcp.example-read')], messages: [] }
    let seen: Context | undefined
    const stream = responsesToolNameStream((_m, c) => {
      seen = c
      return source
    })
    expect(stream(model, input)).toBe(source)
    expect(seen).toBe(input)
    const unsupported = { ...model, api: 'anthropic-messages' } as Model<Api>
    const history = context()
    expect(stream(unsupported, history)).toBe(source)
    expect(seen).toBe(history)
  })
})
