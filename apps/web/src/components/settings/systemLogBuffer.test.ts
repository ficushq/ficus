import { describe, expect, test } from 'bun:test'
import {
  SystemLogBuffer,
  detectLevel,
  parseSystemLogLine,
  sameMatch,
  searchSystemLog,
  type SystemLogLine,
  type SystemLogSnapshot,
} from './systemLogBuffer'

const lines = (snapshot: SystemLogSnapshot): SystemLogLine[] => snapshot.blocks.flatMap((block) => block.lines)
const texts = (snapshot: SystemLogSnapshot) => lines(snapshot).map((line) => line.text)

describe('parseSystemLogLine', () => {
  test('splits off the component prefix and the leading timestamp as their own spans', () => {
    const { line } = parseSystemLogLine('[worker] 2026-11-20T09:07:56.347Z [scheduler] tick', 1)
    expect(line.component).toBe('worker')
    expect(line.text).toBe('[worker] 2026-11-20T09:07:56.347Z [scheduler] tick')
    expect(line.spans).toEqual([
      { text: '[worker] ', className: 'ficus-log-component ficus-log-component-worker' },
      { text: '2026-11-20T09:07:56.347Z', className: 'ficus-log-timestamp' },
      { text: ' [scheduler] tick' },
    ])
  })

  test('keeps lines without a known prefix whole', () => {
    const { line } = parseSystemLogLine('[cron] nothing to do', 1)
    expect(line.component).toBeNull()
    expect(line.spans).toEqual([{ text: '[cron] nothing to do' }])
  })

  test('turns SGR colors into log palette classes, strips other escapes and carries state across lines', () => {
    const first = parseSystemLogLine('[api] \x1b[90mgray\x1b[0m plain \x1b[1;31mbold red\x1b[2K', 1)
    expect(first.line.text).toBe('[api] gray plain bold red')
    expect(first.line.spans.slice(1)).toEqual([
      { text: 'gray', className: 'log-ansi-bright-black' },
      { text: ' plain ' },
      { text: 'bold red', className: 'log-ansi-red font-bold' },
    ])
    const second = parseSystemLogLine('still red\x1b[m done', 2, first.state)
    expect(second.line.spans).toEqual([{ text: 'still red', className: 'log-ansi-red font-bold' }, { text: ' done' }])
  })

  test('ignores 256-color arguments instead of reading them as other codes', () => {
    const { line } = parseSystemLogLine('\x1b[38;5;250mlight\x1b[0m', 1)
    expect(line.spans).toEqual([{ text: 'light' }])
  })

  test('shows what a carriage return leaves on the line and drops control characters', () => {
    expect(parseSystemLogLine('ends with crlf\r', 1).line.text).toBe('ends with crlf')
    expect(parseSystemLogLine('10%\r50%\r100%', 1).line.text).toBe('100%')
    expect(parseSystemLogLine('bell\x07 and \x1b]0;title\x07tab\there', 1).line.text).toBe('bell and tab\there')
  })
})

describe('detectLevel', () => {
  test.each([
    ['2026-11-20T09:07:56.347Z [agent-runner] Error: Unknown model', 'error'],
    ['error: Unknown model gpt-5.4-mini', 'error'],
    ['TypeError: x is not a function', 'error'],
    ['      at validateModelSpec (/opt/ficus/index.js:376956:20)', 'error'],
    ['2026-11-20T09:07:56.347Z [http]   --> GET /api/agents 500 133ms', 'error'],
    ['2026-11-20T09:07:56.347Z [db] Failed to connect, retrying', 'error'],
    ['{"level":"error","msg":"boom"}', 'error'],
    ['something FATAL happened', 'error'],
    ['[ERROR] boom', 'error'],
    ['2026-11-20T09:07:56.347Z [config] Warning: deprecated flag', 'warn'],
    ['level=warn msg="slow query"', 'warn'],
    ['[WARN] disk almost full', 'warn'],
  ])('%s is %s', (message, level) => {
    expect(detectLevel(message)).toBe(level as 'error' | 'warn')
  })

  test.each([
    '2026-11-20T09:07:56.347Z [http]   --> GET /api/errors 200 4ms',
    '2026-11-20T09:07:56.347Z [scheduler] 0 errors in the last hour',
    'lastError: null',
    'processed 3 warnings',
  ])('%s has no level', (message) => {
    expect(detectLevel(message)).toBeNull()
  })

  test('colored logs use the color most of the line is written in', () => {
    const red = parseSystemLogLine('\x1b[90m2026-11-20T09:07:56Z\x1b[0m \x1b[31m[svc] something broke badly\x1b[0m', 1)
    expect(red.line.level).toBe('error')
    const http = parseSystemLogLine('--> GET /api/agents \x1b[33m404\x1b[0m 12ms', 1)
    expect(http.line.level).toBeNull()
    expect(parseSystemLogLine('\x1b[90m[svc] verbose detail\x1b[0m', 1).line.level).toBe('debug')
  })
})

describe('SystemLogBuffer', () => {
  test('joins chunks into lines and shows the unfinished tail as a partial line with a stable id', () => {
    const buffer = new SystemLogBuffer()
    buffer.appendText('[api] first\n[api] sec')
    let snapshot = buffer.snapshot()
    expect(texts(snapshot)).toEqual(['[api] first'])
    expect(snapshot.partial?.text).toBe('[api] sec')
    const partialId = snapshot.partial?.id
    buffer.appendText('ond\n[worker] third\n')
    snapshot = buffer.snapshot()
    expect(texts(snapshot)).toEqual(['[api] first', '[api] second', '[worker] third'])
    expect(lines(snapshot)[1].id).toBe(partialId!)
    expect(snapshot.partial).toBeNull()
    expect(snapshot.appended).toBe(3)
  })

  test('a control message closes the partial line and gets its own line', () => {
    const buffer = new SystemLogBuffer()
    buffer.appendText('[api] half')
    buffer.appendControl('error', 'Log stream failed')
    const snapshot = buffer.snapshot()
    expect(lines(snapshot).map(({ kind, text, level }) => ({ kind, text, level }))).toEqual([
      { kind: 'log', text: '[api] half', level: null },
      { kind: 'error', text: '[Log stream failed]', level: 'error' },
    ])
    expect(snapshot.partial).toBeNull()
  })

  test('only the changed blocks get new identities, and the oldest lines are trimmed at the cap', () => {
    const buffer = new SystemLogBuffer(7, 3)
    buffer.appendText('1\n2\n3\n4\n')
    const before = buffer.snapshot()
    expect(before.blocks.map((block) => block.lines.length)).toEqual([3, 1])
    buffer.appendText('5\n')
    const after = buffer.snapshot()
    expect(after.blocks[0]).toBe(before.blocks[0])
    expect(after.blocks[1]).not.toBe(before.blocks[1])
    buffer.appendText('6\n7\n8\n9\n')
    const trimmed = buffer.snapshot()
    expect(texts(trimmed)).toEqual(['3', '4', '5', '6', '7', '8', '9'])
    expect(trimmed.lineCount).toBe(7)
    expect(trimmed.appended).toBe(9)
    expect(trimmed.blocks.map((block) => block.key)).toEqual([0, 1, 2])
  })

  test('clear empties the buffer without reusing line ids', () => {
    const buffer = new SystemLogBuffer()
    buffer.appendText('old\n')
    const oldId = lines(buffer.snapshot())[0].id
    buffer.clear()
    expect(buffer.snapshot()).toEqual({ blocks: [], partial: null, appended: 0, lineCount: 0 })
    buffer.appendText('new\n')
    expect(lines(buffer.snapshot())[0].id).toBeGreaterThan(oldId)
  })
})

describe('searchSystemLog', () => {
  test('finds every case-insensitive match in display order, including the partial line', () => {
    const buffer = new SystemLogBuffer(100, 2)
    buffer.appendText('[api] GET /a\n[api] get /b get\n[worker] nothing\n[api] Get')
    const matches = searchSystemLog(buffer.snapshot(), 'get')
    expect(matches.map(({ start, end }) => [start, end])).toEqual([
      [6, 9],
      [6, 9],
      [13, 16],
      [6, 9],
    ])
    expect(matches[3].lineId).toBe(buffer.snapshot().partial!.id)
    expect(searchSystemLog(buffer.snapshot(), '')).toEqual([])
    expect(sameMatch(matches[1], { ...matches[1] })).toBe(true)
    expect(sameMatch(matches[1], matches[2])).toBe(false)
    expect(sameMatch(null, matches[0])).toBe(false)
  })
})
