import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { Command } from 'commander'
import { stringify } from 'yaml'
import { createBlankWorkflow, workflowCommandSchema, workflowPresetSchema, workflowSourceSchema } from '@ficus/shared'
import { apiGet, apiPost, apiPut, apiPatch } from '../client'
import { outputError } from '../output'
import { registerWorkflowCommands } from './workflow'
import { registerWorkstreamCommands } from './workstream'
import { registerScheduleCommands } from './schedule'

const definition = createBlankWorkflow()
const preset = workflowPresetSchema.parse({ id: 'example', definition })
const source = workflowSourceSchema.parse({ kind: 'inline', definition })
const command = { action: 'complete', expectedVersion: 7, attemptId: 4, outcome: 'completed', evidence: 'Verified ✓' }
const requestId = '11111111-1111-4111-8111-111111111111'
const sources = ['file', 'content', 'stdin'] as const
const apiMocks = [apiGet, apiPost, apiPut, apiPatch] as Array<ReturnType<typeof mock>>
const originalStdin = Object.getOwnPropertyDescriptor(process, 'stdin')!
const streams: Readable[] = []
let directory: string

function stdin(text: string, isTTY = false, fail = false) {
  const stream = Readable.from(
    (async function* () {
      yield Buffer.from(text.slice(0, 3))
      if (fail) throw new Error('private-stream-error')
      yield Buffer.from(text.slice(3))
    })()
  )
  Object.assign(stream, { isTTY })
  streams.push(stream)
  Object.defineProperty(process, 'stdin', { configurable: true, value: stream })
}
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'workflow-input-'))
  for (const fn of apiMocks) fn.mockReset().mockResolvedValue({ id: 'created-id', title: 'Example' })
  ;(apiGet as ReturnType<typeof mock>).mockResolvedValue({ action: { type: 'create_work_stream', title: 'Existing' } })
  ;(outputError as ReturnType<typeof mock>).mockReset()
})
afterEach(async () => {
  Object.defineProperty(process, 'stdin', originalStdin)
  for (const stream of streams.splice(0)) stream.destroy()
  await rm(directory, { recursive: true, force: true })
})
async function run(args: string[]) {
  const program = new Command()
    .exitOverride()
    .configureOutput({ writeErr: () => {} })
    .option('--json')
  registerWorkflowCommands(program)
  registerWorkstreamCommands(program)
  registerScheduleCommands(program)
  await program.parseAsync(args, { from: 'user' })
}
const matrix = [
  { args: ['workflow', 'create'], value: preset, path: '/api/workflows', body: preset },
  {
    args: ['workflow', 'update', 'example', '--revision', 'inspected'],
    value: preset,
    path: '/api/workflows/example',
    body: { revision: 'inspected', preset },
  },
  {
    args: ['workflow', 'resolve', '--squad', 'squad'],
    value: source,
    path: '/api/workflows/resolve',
    body: { squadId: 'squad', source },
  },
  ...['workstream', 'ws', 'workflow'].map((scope) => ({
    args: [scope, 'advance', 'stream/id', '--request-id', requestId],
    value: command,
    path: '/api/workflows/runs/stream%2Fid/advance',
    body: { command: workflowCommandSchema.parse(command), requestId },
  })),
  {
    args: ['workstream', 'create', 'Example', '--squad', 'squad'],
    value: definition,
    path: '/api/workstreams',
    body: expect.objectContaining({ workflow: source }),
    flow: true,
  },
  {
    args: [
      'schedule',
      'create',
      '--squad',
      'squad',
      '--name',
      'Example',
      '--interval',
      '1h',
      '--action',
      'create_work_stream',
      '--title',
      'Example',
    ],
    value: source,
    path: '/api/schedules',
    body: expect.objectContaining({ action: expect.objectContaining({ workflow: source }) }),
    flow: true,
  },
  {
    args: ['schedule', 'update', 'schedule'],
    value: definition,
    path: '/api/schedules/schedule',
    body: { action: { type: 'create_work_stream', title: 'Existing', workflow: source } },
    flow: true,
  },
]
async function input(mode: (typeof sources)[number], text: string, flow = false) {
  if (mode === 'stdin') {
    stdin(text)
    return [flow ? '--flow-stdin' : '--stdin']
  }
  if (mode === 'content') return [flow ? '--flow-content' : '--content', text]
  const path = join(directory, 'input.yaml')
  await Bun.write(path, text)
  return [flow ? '--flow' : '--file', path]
}
// JSON is valid YAML. The block-style serializer below deliberately exercises multiline YAML too.
const yaml = (value: unknown): string => stringify(value)
for (const entry of matrix) {
  describe(entry.args.slice(0, 2).join(' '), () => {
    for (const format of ['JSON', 'YAML'])
      for (const mode of sources) {
        test(`${format} via ${mode} forwards the same validated payload`, async () => {
          const text = format === 'JSON' ? JSON.stringify(entry.value) : yaml(entry.value)
          await run([...entry.args, ...(await input(mode, text, entry.flow)), '--json'])
          expect(outputError).not.toHaveBeenCalled()
          const mutations = [apiPost, apiPut, apiPatch].flatMap((fn) => (fn as ReturnType<typeof mock>).mock.calls)
          expect(mutations).toEqual([[entry.path, entry.body]])
        })
      }
    test('conflicting sources fail before any API call', async () => {
      await run([
        ...entry.args,
        ...(await input('content', '{}', entry.flow)),
        ...(await input('stdin', '{}', entry.flow)),
      ])
      expect(outputError).toHaveBeenCalledWith(
        expect.objectContaining({ message: expect.stringContaining('exactly one') })
      )
      for (const fn of apiMocks) expect(fn).not.toHaveBeenCalled()
    })
    test('unsupported fields fail before any API call', async () => {
      await run([
        ...entry.args,
        ...(await input('content', JSON.stringify({ ...entry.value, privateField: 'private-value' }), entry.flow)),
      ])
      expect(outputError).toHaveBeenCalledTimes(1)
      expect((outputError as ReturnType<typeof mock>).mock.calls[0][0].message).not.toContain('private')
      for (const fn of apiMocks) expect(fn).not.toHaveBeenCalled()
    })
  })
}
for (const mode of sources)
  for (const text of [
    '',
    '  \n',
    '# comment',
    'null',
    'false',
    '42',
    '[]',
    'filename.yaml',
    '{broken: [',
    'action: complete\naction: rework',
    'a: 1\n---\na: 2',
    'a: !privateTag secret',
    'a: &a [*a]',
    yaml({ ...command, expectedVersion: '7' }),
    yaml({ ...command, secret: 'private-value' }),
  ]) {
    test(`rejects invalid ${mode} input ${JSON.stringify(text).slice(0, 55)}`, async () => {
      await run(['workstream', 'advance', 'id', ...(await input(mode, text))])
      expect(outputError).toHaveBeenCalledTimes(1)
      for (const fn of apiMocks) expect(fn).not.toHaveBeenCalled()
      expect((outputError as ReturnType<typeof mock>).mock.calls[0][0].message).not.toContain('private')
    })
  }
test('missing sources do not implicitly read stdin', async () => {
  stdin(JSON.stringify(command), true)
  await run(['workstream', 'advance', 'id'])
  expect(outputError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('exactly one') }))
  expect(streams[0]!.readableDidRead).toBe(false)
})
for (const mode of sources)
  test(`bounds ${mode} input in bytes`, async () => {
    await run(['workstream', 'advance', 'id', ...(await input(mode, 'é'.repeat(524289)))])
    expect(outputError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('1 MiB') }))
    expect(apiPost).not.toHaveBeenCalled()
  })
for (const tty of [true, false])
  test(tty ? 'stdin refuses interactive terminals without reading' : 'stdin errors are safe', async () => {
    stdin(JSON.stringify(command), tty, !tty)
    await run(['workstream', 'advance', 'id', '--stdin'])
    expect(outputError).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining(tty ? 'pipe or heredoc' : 'read stdin') })
    )
    expect((outputError as ReturnType<typeof mock>).mock.calls[0][0].message).not.toContain('private')
    expect(apiPost).not.toHaveBeenCalled()
    if (tty) expect(streams[0]!.readableDidRead).toBe(false)
  })
test('file read errors do not echo the filename', async () => {
  await run(['workstream', 'advance', 'id', '--file', join(directory, 'private-file')])
  expect(outputError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('read file') }))
  expect((outputError as ReturnType<typeof mock>).mock.calls[0][0].message).not.toContain('private')
})
for (const entry of matrix.filter((e) => e.flow))
  test(`${entry.args.slice(0, 2).join(' ')} rejects preset/source conflicts`, async () => {
    await run([...entry.args, '--workflow', 'solo', '--flow-content', ''])
    expect(outputError).toHaveBeenCalledTimes(1)
    for (const fn of apiMocks) expect(fn).not.toHaveBeenCalled()
  })
test('schedule validates flow before timing lookup or webhook mutation', async () => {
  await run(['schedule', 'update', 'id', '--clear-expires-at', '--enable-webhook', '--flow-content', 'null'])
  for (const fn of apiMocks) expect(fn).not.toHaveBeenCalled()
})
for (const value of [
  { action: 'rework', expectedVersion: 12, attemptId: 4, feedback: 'Fix current finding' },
  {
    action: 'revise',
    expectedVersion: 13,
    attemptId: null,
    operations: [{ op: 'set-completion', completion: { mode: 'deliverable' } }],
    reason: 'Authorized change',
    active: 'keep',
  },
])
  test(`${value.action} preserves the versioned command and generates a retry ID`, async () => {
    await run(['workstream', 'advance', 'id', '--content', JSON.stringify(value)])
    expect(outputError).not.toHaveBeenCalled()
    expect(apiPost).toHaveBeenCalledWith('/api/workflows/runs/id/advance', {
      command: workflowCommandSchema.parse(value),
      requestId: expect.stringMatching(/^[0-9a-f-]{36}$/),
    })
  })
test('repeated source flags and positional-plus-flag files are rejected', async () => {
  for (const args of [
    ['workstream', 'advance', 'id', '--content', '{}', '--content', '{}'],
    ['workstream', 'advance', 'id', '--stdin', '--stdin'],
    ['workflow', 'create', 'saved.yaml', '--content', '{}'],
    ['workflow', 'create', 'saved.yaml', '--file', 'saved.yaml'],
  ]) {
    ;(outputError as ReturnType<typeof mock>).mockClear()
    try {
      await run(args)
    } catch (error) {
      expect((error as Error).message).toContain('once')
      continue
    }
    expect(outputError).toHaveBeenCalled()
  }
  expect(apiPost).not.toHaveBeenCalled()
})

for (const mode of sources)
  test(`bounded acyclic YAML aliases remain usable via ${mode}`, async () => {
    const text = 'action: complete\nexpectedVersion: 7\nattemptId: 4\noutcome: &result completed\nevidence: *result\n'
    await run(['workstream', 'advance', 'id', ...(await input(mode, text))])
    expect(outputError).not.toHaveBeenCalled()
    expect(apiPost).toHaveBeenCalledWith(
      '/api/workflows/runs/id/advance',
      expect.objectContaining({ command: { ...command, outcome: 'completed', evidence: 'completed', resume: false } })
    )
  })
test('YAML mapping keys must be strings rather than silently coerced booleans', async () => {
  const text = yaml(definition).replace('completed:', 'true:')
  expect(text).toContain('true:')
  await run(['workstream', 'create', 'Example', '--squad', 'squad', '--flow-content', text])
  expect(outputError).toHaveBeenCalledTimes(1)
  expect(apiPost).not.toHaveBeenCalled()
})
test('repeating a preset selector is ambiguous', async () => {
  await expect(
    run(['workstream', 'create', 'Example', '--squad', 'squad', '--workflow', 'solo', '--workflow', 'other'])
  ).rejects.toThrow('once')
  expect(apiPost).not.toHaveBeenCalled()
})

for (const entry of matrix.slice(0, 3))
  for (const format of ['JSON', 'YAML'])
    test(`${entry.args.slice(0, 2).join(' ')} retains legacy positional ${format} files`, async () => {
      const [, path] = await input('file', format === 'JSON' ? JSON.stringify(entry.value) : yaml(entry.value))
      await run([...entry.args, path!])
      expect(outputError).not.toHaveBeenCalled()
      expect([apiPost, apiPut].flatMap((fn) => (fn as ReturnType<typeof mock>).mock.calls)).toEqual([
        [entry.path, entry.body],
      ])
    })
for (const pair of [
  ['file', 'content'],
  ['file', 'stdin'],
] as const)
  test(`rejects ${pair.join(' + ')} conflicts before reading`, async () => {
    await run(['workstream', 'advance', 'id', ...(await input(pair[0], '{}')), ...(await input(pair[1], '{}'))])
    expect(outputError).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('exactly one') })
    )
    expect(apiPost).not.toHaveBeenCalled()
    if (pair[1] === 'stdin') expect(streams[0]!.readableDidRead).toBe(false)
  })
for (const entry of matrix.slice(0, 3))
  test(`${entry.args.slice(0, 2).join(' ')} requires an explicit source`, async () => {
    await run(entry.args)
    expect(outputError).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('exactly one') })
    )
    for (const fn of apiMocks) expect(fn).not.toHaveBeenCalled()
  })
test('UTF-8 is decoded across byte-chunk boundaries', async () => {
  const bytes = Buffer.from(JSON.stringify(command))
  const split = bytes.indexOf(Buffer.from('✓')) + 1
  const stream = Readable.from([bytes.subarray(0, split), bytes.subarray(split)])
  streams.push(stream)
  Object.defineProperty(process, 'stdin', { configurable: true, value: stream })
  await run(['workstream', 'advance', 'id', '--stdin'])
  expect(outputError).not.toHaveBeenCalled()
  expect(apiPost).toHaveBeenCalledWith(
    '/api/workflows/runs/id/advance',
    expect.objectContaining({ command: workflowCommandSchema.parse(command) })
  )
})
test('invalid UTF-8 stdin is rejected safely', async () => {
  const stream = Readable.from([Buffer.from([0xff])])
  streams.push(stream)
  Object.defineProperty(process, 'stdin', { configurable: true, value: stream })
  await run(['workstream', 'advance', 'id', '--stdin'])
  expect(outputError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('UTF-8') }))
  expect(apiPost).not.toHaveBeenCalled()
})

test('extra positional inputs cannot be silently ignored', async () => {
  const [, path] = await input('file', JSON.stringify(preset))
  await expect(run(['workflow', 'create', path!, 'another.yaml'])).rejects.toThrow('too many arguments')
  expect(apiPost).not.toHaveBeenCalled()
})
