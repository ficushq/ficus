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
    { method: 'GET', path: '/api/workflows/runs/stream-id' },
    { method: 'POST', path: '/api/workflows/runs/stream-id/advance', body: { command, requestId } },
    { method: 'POST', path: '/api/workflows/runs/stream-id/finish', body: { version: 8 } },
  ])
  // Whether empty evidence is acceptable depends on the step, so only the server decides that.
  await f.run('advance', 'stream-id', '--file', await file({ ...command, evidence: undefined }))
  await f.run('finish', 'stream-id', '--version', '-1')
  expect(f.errors).toHaveLength(2)
  expect(f.calls).toHaveLength(4)
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

/** A run detail at version 7 whose attempt 4 has the given status. */
const runAt = (status = 'running', version = 7) => ({ version, state: { attempts: [{ id: 4, status }] } })
const runPath = { method: 'GET', path: '/api/workflows/runs/stream-id' }

test('advance --attach uploads each file to the completing attempt before advancing', async () => {
  const command = { action: 'complete', expectedVersion: 7, attemptId: 4, outcome: 'completed', evidence: 'See design' }
  const dir = await mkdtemp(join(tmpdir(), 'ficus-attach-cli-'))
  dirs.push(dir)
  await Bun.write(join(dir, 'design.md'), '# Design')
  await Bun.write(join(dir, 'notes.txt'), 'notes')
  const design = join(dir, 'design.md')
  const notes = join(dir, 'notes.txt')
  const commandFile = await file(command)

  const f = fixture(runAt(), undefined, 'workstream')
  await f.run('advance', 'stream-id', '--file', commandFile, '--attach', design, '--attach', notes)
  expect(f.errors).toEqual([])
  expect(f.calls).toEqual([
    runPath,
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
  const failing = fixture(runAt(), undefined, 'workstream', (index) =>
    index === 1 ? new Error('ATTACHMENT_TOO_LARGE') : undefined
  )
  await failing.run('advance', 'stream-id', '--file', commandFile, '--attach', design, '--attach', notes)
  expect(failing.errors.map((error) => error.message)).toEqual(['ATTACHMENT_TOO_LARGE'])
  expect(failing.calls.map((call) => call.method)).toEqual(['GET', 'UPLOAD', 'UPLOAD'])
})

test('advance --attach retries reach the advance receipt, and a stale version uploads nothing', async () => {
  const command = { action: 'complete', expectedVersion: 7, attemptId: 4, outcome: 'completed', evidence: 'See design' }
  const dir = await mkdtemp(join(tmpdir(), 'ficus-attach-cli-'))
  dirs.push(dir)
  const design = join(dir, 'design.md')
  await Bun.write(design, '# Design')
  const commandFile = await file(command)
  const requestId = crypto.randomUUID()

  // The first attempt already completed: re-sending the same request gets its receipt, not an upload error.
  const retried = fixture(runAt('completed', 8), undefined, 'workstream')
  await retried.run('advance', 'stream-id', '--file', commandFile, '--attach', design, '--request-id', requestId)
  expect(retried.errors).toEqual([])
  expect(retried.calls).toEqual([
    runPath,
    {
      method: 'POST',
      path: '/api/workflows/runs/stream-id/advance',
      body: { command: { ...command, resume: false }, requestId },
    },
  ])

  // The run moved on while the attempt is still open: fail as the server would, before uploading.
  const stale = fixture(runAt('running', 9), undefined, 'workstream')
  await stale.run('advance', 'stream-id', '--file', commandFile, '--attach', design)
  expect(stale.errors.map((error) => error.message)).toEqual(['Stale flow version'])
  expect(stale.calls).toEqual([runPath])
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
  const f = fixture(runAt(), undefined, 'workstream')
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
  // Only the run was read; nothing was uploaded or advanced.
  expect(f.calls.every((call) => call.method === 'GET')).toBe(true)
})

test('decision briefs are preflighted before any attachment upload and transported intact', async () => {
  const { createBlankWorkflow, createWorkflowRun } = await import('@ficus/shared')
  const definition = createBlankWorkflow()
  definition.steps[0]!.outcomes.completed = { next: 'gate' }
  definition.steps.push({
    id: 'gate',
    kind: 'human-approval',
    instructions: 'Review staging.',
    output: 'Decision.',
    approver: 'reviewers',
    outcomes: { yes: { next: 'finish' } },
  })
  const state = createWorkflowRun(definition)
  const f = fixture({ version: 0, state }, undefined, 'workstream')
  const command = {
    action: 'complete',
    expectedVersion: 0,
    attemptId: 1,
    outcome: 'completed',
    evidence: 'Audit result.',
  }
  const path = await file('Attachment content.')
  await f.run('advance', 'stream-id', '--content', JSON.stringify(command), '--attach', path)
  expect(f.calls.map((c) => c.method)).toEqual(['GET'])
  expect(f.errors[0]!.message).toContain('decisionBrief is required')
  const decisionBrief = {
    decision: 'Approve the staging design.',
    recommendation: 'Approve because the fallback is tested.',
    approvalEffect: 'Approval permits staging work only, not production deployment.',
    risks: 'The fallback increases maintenance work.',
  }
  const valid = fixture({ version: 0, state }, undefined, 'workstream')
  await valid.run('advance', 'stream-id', '--content', JSON.stringify({ ...command, decisionBrief }))
  expect(valid.errors).toEqual([])
  expect(valid.calls.at(-1)?.body).toMatchObject({ command: { decisionBrief } })
})

test('malformed or compressed decision fields fail locally without GET, upload or POST', async () => {
  for (const decisionBrief of [
    null,
    { decision: 'pls approve this' },
    {
      decision: 'Approve the staging design.',
      recommendation: 'Approve because tests passed.',
      approvalEffect: 'Approval permits staging only.',
      risks: 'Please approveTheExactRetryPacket before implementation.',
    },
  ]) {
    const f = fixture(undefined, undefined, 'workstream')
    await f.run(
      'advance',
      'stream-id',
      '--content',
      JSON.stringify({
        action: 'complete',
        expectedVersion: 0,
        attemptId: 1,
        outcome: 'ready',
        evidence: 'Audit result.',
        decisionBrief,
      })
    )
    expect(f.calls).toEqual([])
    expect(f.errors).toHaveLength(1)
    expect(f.errors[0]!.message).toContain('decisionBrief')
  }
})

test('explicit agent returns preflight human briefs and transport them without changing attachment semantics', async () => {
  const { createBlankWorkflow, createWorkflowRun } = await import('@ficus/shared')
  const { brief } = await import('../../../../packages/shared/src/test-fixtures/workflow-review')
  const definition = createBlankWorkflow()
  definition.steps[0]!.outcomes.completed = { returnTo: 'gate', afterRework: 'return-to-requester' }
  definition.steps.push({
    id: 'gate',
    kind: 'human-approval',
    instructions: 'Review staging.',
    output: 'Decision.',
    outcomes: { yes: { next: 'finish' } },
  })
  const state = createWorkflowRun(definition)
  const command = {
    action: 'return',
    expectedVersion: 0,
    attemptId: 1,
    targetStepId: 'gate',
    resumeAt: 'execute',
    feedback: 'Review the revised staging scope.',
  }
  const missing = fixture({ version: 0, state }, undefined, 'workstream')
  await missing.run('advance', 'stream-id', '--content', JSON.stringify(command))
  expect(missing.calls.map((c) => c.method)).toEqual(['GET'])
  expect(missing.errors[0]!.message).toContain('decisionBrief')
  const valid = fixture({ version: 0, state }, undefined, 'workstream')
  await valid.run('advance', 'stream-id', '--content', JSON.stringify({ ...command, decisionBrief: brief }))
  expect(valid.errors).toEqual([])
  expect(valid.calls.at(-1)?.body).toMatchObject({ command: { action: 'return', decisionBrief: brief } })
  const invalid = fixture({ version: 0, state }, undefined, 'workstream')
  await invalid.run(
    'advance',
    'stream-id',
    '--content',
    JSON.stringify({ ...command, decisionBrief: { ...brief, risks: 'pls approve this' } })
  )
  expect(invalid.calls).toEqual([])
  expect(invalid.errors[0]!.message).toContain('decisionBrief.risks')
})
