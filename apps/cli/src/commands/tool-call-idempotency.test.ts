import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { Command } from 'commander'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { z } from 'zod'
import { TOOL_CALL_KEY_ENV, toolCallIdempotencyKey } from '@ficus/shared/node'
import { apiPost, apiPostForm } from '../client'
import { output } from '../output'
import { registerInboxCommands } from './inbox'
import { registerWorkstreamFlowCommands } from './workstream-flow'

const callOne = toolCallIdempotencyKey(
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
  'toolu_1'
)
const callTwo = toolCallIdempotencyKey(
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
  'toolu_2'
)

let savedKey: string | undefined
beforeEach(() => {
  savedKey = process.env[TOOL_CALL_KEY_ENV]
  delete process.env[TOOL_CALL_KEY_ENV]
})
afterEach(() => {
  if (savedKey === undefined) delete process.env[TOOL_CALL_KEY_ENV]
  else process.env[TOOL_CALL_KEY_ENV] = savedKey
})

describe('workstream advance request ID inside a tool call', () => {
  const command = {
    action: 'complete',
    expectedVersion: 3,
    attemptId: 1,
    outcome: 'completed',
    evidence: 'Verified',
  }

  async function advance(args: string[], content: unknown = command): Promise<string> {
    const bodies: Array<{ requestId: string }> = []
    const program = new Command().exitOverride()
    registerWorkstreamFlowCommands(program.command('workstream'), {
      // No flow snapshot: the command goes straight to the server, as for an already closed attempt.
      apiGet: async () => null as never,
      apiPost: async (_path, body) => {
        bodies.push(body as { requestId: string })
        return { ok: true } as never
      },
      output: () => {},
      outputError: (error) => {
        throw error
      },
    })
    await program.parseAsync(['workstream', 'advance', '1531', '--content', JSON.stringify(content), ...args], {
      from: 'user',
    })
    return bodies[0]!.requestId
  }

  test('re-running the same command in the same tool call is the same request', async () => {
    process.env[TOOL_CALL_KEY_ENV] = callOne
    const first = await advance([])
    expect(z.uuid().safeParse(first).success).toBe(true)
    expect(await advance([])).toBe(first)
    // Key order in the submitted JSON does not matter.
    expect(
      await advance([], {
        evidence: 'Verified',
        outcome: 'completed',
        attemptId: 1,
        expectedVersion: 3,
        action: 'complete',
      })
    ).toBe(first)
  })

  test('a different command or another tool call is a different request', async () => {
    process.env[TOOL_CALL_KEY_ENV] = callOne
    const first = await advance([])
    expect(await advance([], { ...command, evidence: 'Verified again' })).not.toBe(first)
    process.env[TOOL_CALL_KEY_ENV] = callTwo
    expect(await advance([])).not.toBe(first)
  })

  test('an explicit --request-id still wins, and outside a tool call each run is new', async () => {
    process.env[TOOL_CALL_KEY_ENV] = callOne
    const explicit = '33333333-3333-4333-8333-333333333333'
    expect(await advance(['--request-id', explicit])).toBe(explicit)
    delete process.env[TOOL_CALL_KEY_ENV]
    expect(await advance([])).not.toBe(await advance([]))
  })
})

describe('inbox send idempotency key inside a tool call', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ficus-inbox-key-'))
    ;(apiPost as ReturnType<typeof mock>).mockReset()
    ;(apiPost as ReturnType<typeof mock>).mockResolvedValue({ id: 'message-12345678' })
    ;(apiPostForm as ReturnType<typeof mock>).mockReset()
    ;(apiPostForm as ReturnType<typeof mock>).mockResolvedValue({})
    ;(output as ReturnType<typeof mock>).mockClear()
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  async function send(args: string[]): Promise<Record<string, unknown>> {
    const program = new Command().exitOverride()
    registerInboxCommands(program)
    await program.parseAsync(['inbox', 'send', ...args], { from: 'user' })
    const calls = (apiPost as ReturnType<typeof mock>).mock.calls
    return calls.at(-1)![1] as Record<string, unknown>
  }

  test('the same message in the same tool call gets the same key; other messages do not', async () => {
    process.env[TOOL_CALL_KEY_ENV] = callOne
    const first = (await send(['agent-1', 'review please', '-s', 'PR'])).idempotencyKey
    expect(z.uuid().safeParse(first).success).toBe(true)
    expect((await send(['agent-1', 'review please', '-s', 'PR'])).idempotencyKey).toBe(first)
    // One bash call that sends several different messages still sends each of them.
    expect((await send(['agent-2', 'review please', '-s', 'PR'])).idempotencyKey).not.toBe(first)
    expect((await send(['agent-1', 'second note', '-s', 'PR'])).idempotencyKey).not.toBe(first)
    expect((await send(['agent-1', 'review please', '-s', 'PR', '--follow-up'])).idempotencyKey).not.toBe(first)
    process.env[TOOL_CALL_KEY_ENV] = callTwo
    expect((await send(['agent-1', 'review please', '-s', 'PR'])).idempotencyKey).not.toBe(first)
  })

  test('an explicit --idempotency-key wins, and outside a tool call no key is sent', async () => {
    process.env[TOOL_CALL_KEY_ENV] = callOne
    expect((await send(['agent-1', 'hi', '--idempotency-key', 'mine'])).idempotencyKey).toBe('mine')
    delete process.env[TOOL_CALL_KEY_ENV]
    expect(await send(['agent-1', 'hi'])).not.toHaveProperty('idempotencyKey')
  })

  test('attached file contents are part of the key', async () => {
    process.env[TOOL_CALL_KEY_ENV] = callOne
    const file = join(dir, 'report.txt')
    writeFileSync(file, 'first')
    const first = (await send(['agent-1', 'see attached', '--attach', file])).idempotencyKey
    writeFileSync(file, 'second')
    expect((await send(['agent-1', 'see attached', '--attach', file])).idempotencyKey).not.toBe(first)
  })

  test('a replayed send uploads only the files the first run did not attach', async () => {
    process.env[TOOL_CALL_KEY_ENV] = callOne
    const kept = join(dir, 'kept.txt')
    const missing = join(dir, 'missing.txt')
    writeFileSync(kept, 'kept')
    writeFileSync(missing, 'missing')
    const keptSha = new Bun.CryptoHasher('sha256').update('kept').digest('hex')
    ;(apiPost as ReturnType<typeof mock>).mockResolvedValue({
      id: 'message-12345678',
      idempotentReplay: true,
      attachments: [{ filename: 'kept.txt', sha256: keptSha }],
    })
    await send(['agent-1', 'see attached', '--attach', kept, '--attach', missing])
    const uploads = (apiPostForm as ReturnType<typeof mock>).mock.calls
    expect(uploads).toHaveLength(1)
    expect(((uploads[0]![1] as FormData).get('file') as File).name).toBe('missing.txt')
    expect((output as ReturnType<typeof mock>).mock.calls.at(-1)![1]).toContain('already sent')
  })
})
