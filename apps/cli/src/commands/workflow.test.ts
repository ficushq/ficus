import { registerWorkstreamCommands } from './workstream'
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Command } from 'commander'
import { workflowPresetSchema } from '@ficus/shared'
import { registerWorkflowCommands, type WorkflowDependencies } from './workflow'

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})
async function file(value: unknown) {
  const dir = await mkdtemp(join(tmpdir(), 'ficus-workflow-cli-'))
  dirs.push(dir)
  const path = join(dir, 'style.json')
  await Bun.write(path, JSON.stringify(value))
  return path
}
function fixture(
  response: unknown = { ok: true },
  failure?: Error,
  scope: 'workflow' | 'workstream' | 'ws' = 'workflow',
  uploadFailure?: (index: number) => Error | undefined
) {
  const calls: Array<{ method: string; path: string; body?: unknown }> = []
  let uploads = 0
  const printed: unknown[] = []
  const messages: string[] = []
  const errors: Error[] = []
  const request = (method: string) => async (path: string, body?: unknown) => {
    calls.push({ method, path, body })
    if (failure) throw failure
    return response
  }
  const deps = {
    apiGet: request('GET'),
    apiPost: request('POST'),
    apiPut: request('PUT'),
    apiDelete: request('DELETE'),
    apiPostForm: async (path: string, form: FormData) => {
      const file = form.get('file') as File
      calls.push({
        method: 'UPLOAD',
        path,
        body: { name: file.name, text: await file.text(), path: form.get('path') },
      })
      const error = uploadFailure?.(uploads++)
      if (error) throw error
      return { id: `attachment-${uploads}` }
    },
    apiGetRaw: async (path: string) => {
      calls.push({ method: 'GET', path })
      return new Response('id: solo\n')
    },
    output: (value: unknown, message?: string) => {
      printed.push(value)
      if (message) messages.push(message)
    },
    print: (value: unknown) => {
      printed.push(value)
    },
    outputError: (error: Error) => {
      errors.push(error)
    },
  } as WorkflowDependencies
  return {
    calls,
    printed,
    messages,
    errors,
    run: async (...args: string[]) => {
      const program = new Command().exitOverride().configureOutput({ writeErr: () => {} })
      if (scope === 'workflow') registerWorkflowCommands(program, deps)
      else registerWorkstreamCommands(program, deps)
      await program.parseAsync([scope, ...args], { from: 'user' })
    },
  }
}
async function solo() {
  return workflowPresetSchema.parse(
    Bun.YAML.parse(await Bun.file(new URL('../../../../config/workflows/solo.yaml', import.meta.url)).text())
  )
}
describe('workflow CLI', () => {
  test('schema prints step kinds and a kind’s fields offline, generated from the validation schema', async () => {
    const f = fixture()
    await f.run('schema')
    await f.run('schema', 'human-approval')
    await f.run('schema', 'approval')
    expect(f.calls).toEqual([])
    expect(f.messages[0]).toContain('human-approval  A person with review permission chooses the outcome')
    expect(f.messages[1]).toMatch(/^human-approval step/)
    expect(f.messages[1]).toMatch(/Required:\n(?: {2}.+\n)* {2}output {8}text/)
    expect(f.messages[1]).toContain('approver  assigned-reviewers | reviewers. default: "assigned-reviewers"')
    // --json gets the same reference as data.
    expect(f.printed[1]).toMatchObject({
      kind: 'human-approval',
      required: expect.arrayContaining([expect.objectContaining({ name: 'output' })]),
      optional: expect.arrayContaining([
        expect.objectContaining({ name: 'approver', type: 'assigned-reviewers | reviewers' }),
      ]),
    })
    expect(f.errors.map((error) => error.message)).toEqual([
      'Unknown step kind; use one of: agent, human-approval, decision',
    ])
  })
  test('publishes validated YAML and preserves the explicit revision when replacing a preset', async () => {
    const preset = await solo()
    const path = await file(preset)
    const f = fixture()
    await f.run('create', path)
    await f.run('update', preset.id, path, '--revision', 'inspected-revision')
    expect(f.calls).toEqual([
      { method: 'POST', path: '/api/workflows', body: preset },
      { method: 'PUT', path: '/api/workflows/solo', body: { revision: 'inspected-revision', preset } },
    ])
    expect(f.errors).toEqual([])
    const yamlPath = new URL('../../../../config/workflows/solo.yaml', import.meta.url).pathname
    await f.run('create', yamlPath)
    expect(f.calls[2]!.body).toEqual(preset)
  })
  test('malformed graphs, mismatched IDs and missing revisions never reach the API', async () => {
    const f = fixture()
    await f.run('create', await file({ id: 'bad', definition: {} }))
    await f.run('update', 'other', await file(await solo()), '--revision', 'old')
    expect(f.errors).toHaveLength(2)
    for (const command of ['update', 'delete', 'disable', 'enable', 'revert']) {
      const args = command === 'update' ? [command, 'solo', '/missing/file'] : [command, 'solo']
      await expect(f.run(...args)).rejects.toThrow('required option')
    }
    expect(f.calls).toEqual([])
  })
  test('inline preview does not publish a catalog record', async () => {
    const source = { kind: 'inline', definition: (await solo()).definition }
    const f = fixture()
    await f.run('resolve', await file(source), '--squad', 'squad-id')
    expect(f.calls).toEqual([{ method: 'POST', path: '/api/workflows/resolve', body: { squadId: 'squad-id', source } }])
  })
  test('conflicts are reported without fetching a newer revision or retrying the mutation', async () => {
    const conflict = new Error('Workflow changed; reload it before editing')
    const f = fixture(undefined, conflict)
    await f.run('update', 'solo', await file(await solo()), '--revision', 'old')
    expect(f.calls).toHaveLength(1)
    expect(f.errors).toEqual([conflict])
    expect(f.printed).toEqual([])
  })
  test('enable, disable, revert and delete send their inspected revisions; reads preserve complete output', async () => {
    const f = fixture({ revision: 'current' })
    for (const name of ['enable', 'disable', 'revert', 'delete']) await f.run(name, 'solo', '--revision', 'current')
    expect(f.calls).toEqual([
      { method: 'POST', path: '/api/workflows/solo/disabled', body: { revision: 'current', disabled: false } },
      { method: 'POST', path: '/api/workflows/solo/disabled', body: { revision: 'current', disabled: true } },
      { method: 'POST', path: '/api/workflows/solo/revert', body: { revision: 'current' } },
      { method: 'DELETE', path: '/api/workflows/solo', body: { revision: 'current' } },
    ])
    await f.run('get', 'solo')
    expect(f.printed.at(-1)).toEqual({ revision: 'current' })
    await f.run('export', 'solo')
    expect(f.printed.at(-1)).toBe('id: solo\n')
  })
})

test('workstream flow commands preserve inspected versions and retry IDs, and reject invalid commands locally', async () => {
  const f = fixture(undefined, undefined, 'workstream')
  const command = {
    action: 'complete',
    expectedVersion: 7,
    attemptId: 4,
    outcome: 'completed',
    evidence: 'Verified',
    resume: false,
  }
  const requestId = crypto.randomUUID()
  await f.run('flow', 'stream-id')
  await f.run('advance', 'stream-id', '--file', await file(command), '--request-id', requestId)
  await f.run('finish', 'stream-id', '--version', '8')
  expect(f.calls).toEqual([
    { method: 'GET', path: '/api/workflows/runs/stream-id' },
    { method: 'POST', path: '/api/workflows/runs/stream-id/advance', body: { command, requestId } },
    { method: 'POST', path: '/api/workflows/runs/stream-id/finish', body: { version: 8 } },
  ])
  // Whether empty evidence is acceptable depends on the step, so only the server decides that.
  await f.run('advance', 'stream-id', '--file', await file({ ...command, evidence: undefined }))
  await f.run('finish', 'stream-id', '--version', '-1')
  expect(f.errors).toHaveLength(2)
  expect(f.calls).toHaveLength(3)
})

test('workstream alias exposes execution commands and workflow help only advertises templates', async () => {
  const f = fixture(undefined, undefined, 'ws')
  await f.run('flow', 'stream-id')
  expect(f.calls).toEqual([{ method: 'GET', path: '/api/workflows/runs/stream-id' }])
  const program = new Command()
  registerWorkflowCommands(program)
  const help = program.commands[0]!.helpInformation()
  expect(help).toContain('create')
  for (const name of ['run <id>', 'advance', 'finish']) expect(help).not.toContain(name)
  const legacy = fixture()
  await legacy.run('run', 'stream-id')
  expect(legacy.calls).toEqual(f.calls)
})

test('advance help distinguishes live outcomes from deliberate session restart', () => {
  const program = new Command()
  registerWorkstreamCommands(program)
  const command = program.commands.find((c) => c.name() === 'workstream')!.commands.find((c) => c.name() === 'advance')!
  let help = ''
  command.configureOutput({
    writeOut: (text) => {
      help += text
    },
  })
  command.outputHelp()
  expect(help).toContain('active=keep')
  expect(help).toContain('active=restart')
  expect(help).toContain('outcomeUpdates')
})

test('advance --attach uploads each file to the completing attempt before advancing', async () => {
  const command = { action: 'complete', expectedVersion: 7, attemptId: 4, outcome: 'completed', evidence: 'See design' }
  const dir = await mkdtemp(join(tmpdir(), 'ficus-attach-cli-'))
  dirs.push(dir)
  await Bun.write(join(dir, 'design.md'), '# Design')
  await Bun.write(join(dir, 'notes.txt'), 'notes')
  const design = join(dir, 'design.md')
  const notes = join(dir, 'notes.txt')
  const commandFile = await file(command)

  const f = fixture(undefined, undefined, 'workstream')
  await f.run('advance', 'stream-id', '--file', commandFile, '--attach', design, '--attach', notes)
  expect(f.errors).toEqual([])
  expect(f.calls).toEqual([
    {
      method: 'UPLOAD',
      path: '/api/workflows/runs/stream-id/attempts/4/attachments',
      body: { name: 'design.md', text: '# Design', path: design },
    },
    {
      method: 'UPLOAD',
      path: '/api/workflows/runs/stream-id/attempts/4/attachments',
      body: { name: 'notes.txt', text: 'notes', path: notes },
    },
    {
      method: 'POST',
      path: '/api/workflows/runs/stream-id/advance',
      body: { command: { ...command, resume: false }, requestId: expect.any(String) },
    },
  ])

  // A failed upload means the handoff would be missing a file: nothing is advanced.
  const failing = fixture(undefined, undefined, 'workstream', (index) =>
    index === 1 ? new Error('ATTACHMENT_TOO_LARGE') : undefined
  )
  await failing.run('advance', 'stream-id', '--file', commandFile, '--attach', design, '--attach', notes)
  expect(failing.errors.map((error) => error.message)).toEqual(['ATTACHMENT_TOO_LARGE'])
  expect(failing.calls.map((call) => call.method)).toEqual(['UPLOAD', 'UPLOAD'])
})

test('advance --attach checks every file locally before uploading any', async () => {
  const command = { action: 'complete', expectedVersion: 7, attemptId: 4, outcome: 'completed', evidence: 'See design' }
  const dir = await mkdtemp(join(tmpdir(), 'ficus-attach-cli-'))
  dirs.push(dir)
  const small = join(dir, 'design.md')
  const large = join(dir, 'capture.png')
  const empty = join(dir, 'empty.md')
  await Bun.write(small, '# Design')
  await Bun.write(large, new Uint8Array(10 * 1024 * 1024 + 1))
  await Bun.write(empty, '')
  const commandFile = await file(command)
  const f = fixture(undefined, undefined, 'workstream')
  await f.run('advance', 'stream-id', '--file', commandFile, '--attach', small, '--attach', large)
  await f.run('advance', 'stream-id', '--file', commandFile, '--attach', small, '--attach', empty)
  await f.run('advance', 'stream-id', '--file', commandFile, '--attach', join(dir, 'missing.md'))
  const many = Array.from({ length: 11 }, () => ['--attach', small]).flat()
  await f.run('advance', 'stream-id', '--file', commandFile, ...many)
  const rework = { action: 'rework', expectedVersion: 7, attemptId: 4, feedback: 'Again' }
  await f.run('advance', 'stream-id', '--file', await file(rework), '--attach', small)
  expect(f.errors.map((error) => error.message)).toEqual([
    `${large} is larger than the 10 MB attachment limit`,
    `${empty} is empty`,
    expect.stringContaining('missing.md'),
    'At most 10 files can be attached to one handoff',
    '--attach is only available when completing an attempt',
  ])
  expect(f.calls).toEqual([])
})
