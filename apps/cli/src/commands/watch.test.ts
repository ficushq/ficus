import { beforeEach, describe, expect, it, mock } from 'bun:test'
import { Command } from 'commander'
import { apiGet } from '../client'
import { encodeCursor } from '../watch/cursor'
import type { Snapshot } from '../watch/snapshot'
import { formatResult, parseWatchOptions, registerWatchCommands } from './watch'

const empty = (): Snapshot => ({ v: 1, streams: {}, actions: {}, inbox: {} })

describe('parseWatchOptions', () => {
  it('applies defaults', () => {
    expect(parseWatchOptions({})).toEqual({
      squadId: undefined,
      follow: false,
      pollMs: 60_000,
      timeoutMs: undefined,
      initial: undefined,
    })
  })

  it('converts seconds, decodes the cursor, and forwards the squad', () => {
    const parsed = parseWatchOptions({
      squad: 'sq',
      follow: true,
      poll: '5',
      timeout: undefined,
      cursor: encodeCursor(empty()),
    })
    expect(parsed).toEqual({ squadId: 'sq', follow: true, pollMs: 5_000, timeoutMs: undefined, initial: empty() })
    expect(parseWatchOptions({ timeout: '30' }).timeoutMs).toBe(30_000)
  })

  it('rejects a non-positive poll interval and a bad cursor', () => {
    expect(() => parseWatchOptions({ poll: '0' })).toThrow(/--poll/)
    expect(() => parseWatchOptions({ poll: 'abc' })).toThrow(/--poll/)
    expect(() => parseWatchOptions({ cursor: '!!' })).toThrow(/Invalid --cursor/)
  })

  it('rejects --timeout together with --follow', () => {
    expect(() => parseWatchOptions({ follow: true, timeout: '5' })).toThrow(/--timeout/)
  })
})

describe('formatResult', () => {
  const result = {
    at: '2026-09-11T00:00:00.000Z',
    cursor: 'c',
    events: [{ kind: 'health.recovered' as const, key: 'health:recovered', label: 'Snapshot polling recovered' }],
  }

  it('prints one compact JSON line in follow mode and pretty JSON otherwise', () => {
    expect(formatResult(result, { json: true, follow: true })).toBe(JSON.stringify(result))
    expect(formatResult(result, { json: true, follow: false })).toBe(JSON.stringify(result, null, 2))
  })

  it('prints labels in human mode, and nothing for an empty batch', () => {
    expect(formatResult(result, { json: false, follow: false })).toBe('Snapshot polling recovered')
    expect(formatResult({ ...result, events: [] }, { json: false, follow: false })).toBeNull()
    expect(formatResult({ ...result, events: [] }, { json: true, follow: false })).toBe(
      JSON.stringify({ ...result, events: [] }, null, 2)
    )
  })
})

describe('ficus watch command', () => {
  beforeEach(() => {
    ;(apiGet as ReturnType<typeof mock>).mockReset()
  })

  it('registers the expected options', () => {
    const program = new Command()
    registerWatchCommands(program)
    const watch = program.commands.find((c) => c.name() === 'watch')
    expect(watch).toBeDefined()
    const longs = watch!.options.map((o) => o.long).sort()
    expect(longs).toEqual(['--cursor', '--follow', '--poll', '--squad', '--timeout'])
  })

  it('runs once against the API with a timeout and exits cleanly with an empty batch', async () => {
    ;(apiGet as ReturnType<typeof mock>).mockResolvedValue([])
    const lines: string[] = []
    const program = new Command()
    program.exitOverride()
    registerWatchCommands(program, { print: (line) => lines.push(line), openSocket: () => null })
    await program.parseAsync(['watch', '--timeout', '1', '--poll', '3600'], { from: 'user' })
    expect(apiGet).toHaveBeenCalledWith('/api/actions/pending')
    expect(apiGet).toHaveBeenCalledWith('/api/inbox/user/me?limit=200')
    expect(apiGet).toHaveBeenCalledWith('/api/workstreams?statuses=active%2Cqueued')
    expect(lines).toHaveLength(0) // human mode, empty batch prints nothing
  })
})
