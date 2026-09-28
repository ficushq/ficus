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
  const dir = await mkdtemp(join(tmpdir(), 'tau-workflow-cli-'))
  dirs.push(dir)
  const path = join(dir, 'style.json')
  await Bun.write(path, JSON.stringify(value))
  return path
}
function fixture(
  response: unknown = { ok: true },
  failure?: Error,
  scope: 'workflow' | 'workstream' | 'ws' = 'workflow'
) {
  const calls: Array<{ method: string; path: string; body?: unknown }> = []
  const printed: unknown[] = []
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
    apiGetRaw: async (path: string) => {
      calls.push({ method: 'GET', path })
      return new Response('id: solo\n')
    },
    output: (value: unknown) => {
      printed.push(value)
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
  await f.run('advance', 'stream-id', '--file', await file({ ...command, evidence: '' }))
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
