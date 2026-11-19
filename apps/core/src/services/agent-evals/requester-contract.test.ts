import { expect, test } from 'bun:test'
import { join } from 'node:path'
import type { Command } from 'commander'
import type { Trace, TraceCall } from './define'
import { requesterResponder, REQUESTER } from './requester-fixture'
import { gradeRequester } from './requester-grade'
import { variantContext, workingTreeVariant } from './variant'

const { createProgram } = (await import(join(import.meta.dir, '../../../../cli/src/program.ts'))) as {
  createProgram: () => Command
}

const context = variantContext(workingTreeVariant())
const otherReviewer = '7a9e3c21-5b4d-4f6e-8a1b-2c3d4e5f6a7b'
const trace = (calls: TraceCall[]): Trace => ({ ended: true, steps: [{ text: '', calls }] })
const shell = (command: string, result: string): TraceCall => ({ name: 'squad_bash', args: { command }, result })

for (const option of [`--reviewer=${REQUESTER.userId}`, `--reviewer ${REQUESTER.userId}`]) {
  test(`actual create/update/get responses and grading agree for ${option.split(REQUESTER.userId)[0]}`, async () => {
    const respond = requesterResponder()
    const calls: TraceCall[] = []
    const invoke = async (command: string) => {
      const result = (await respond({ name: 'squad_bash', args: { command }, command }, context))!
      calls.push(shell(command, result))
      return JSON.parse(result)
    }
    const created = await invoke('ficus workstream create "Fix"')
    expect(created.assignedReviewerIds).toEqual([])
    const updated = await invoke(`ficus workstream update ${created.number} ${option}`)
    expect(updated.assignedReviewerIds).toEqual([REQUESTER.userId])
    const inspected = await invoke(`ficus workstream get ${created.id} --json`)
    expect(inspected).toEqual(updated)
    expect(gradeRequester(trace(calls), REQUESTER.userId, [otherReviewer]).pass).toBe(true)
  })
}

test('repeated reviewer flags replace the prior list using the real CLI collection semantics', async () => {
  const respond = requesterResponder()
  const invoke = async (command: string) =>
    JSON.parse((await respond({ name: 'squad_bash', args: { command }, command }, context))!)
  const created = await invoke(`ficus workstream create "Fix" --reviewer=${otherReviewer} --reviewer ${otherReviewer}`)
  expect(created.assignedReviewerIds).toEqual([otherReviewer, otherReviewer])
  const options = [`--reviewer=${REQUESTER.userId}`, '--reviewer', otherReviewer, `--reviewer=${REQUESTER.userId}`]
  const command = createProgram()
    .commands.find((command) => command.name() === 'workstream')!
    .commands.find((command) => command.name() === 'update')!
  command.parseOptions([String(created.number), ...options])
  const updated = await invoke(`ficus workstream update ${created.number} ${options.join(' ')}`)
  expect(updated.assignedReviewerIds).toEqual(command.opts().reviewer)
  expect(updated.assignedReviewerIds).toEqual([REQUESTER.userId, otherReviewer, REQUESTER.userId])
  const replaced = await invoke(`ficus workstream update ${created.number} --reviewer=${REQUESTER.userId}`)
  expect(replaced.assignedReviewerIds).toEqual([REQUESTER.userId])
  expect((await invoke(`ficus workstream get ${created.id} --json`)).assignedReviewerIds).toEqual([REQUESTER.userId])
})

test('an unrelated inspected stream cannot become the created stream through compound output', () => {
  const create = shell(
    'ficus workstream get 9999 --json; ficus workstream create "Fix"',
    '{"id":"unrelated-id","number":9999}\n{"id":"created-id","number":1301}'
  )
  for (const target of ['unrelated-id', '9999']) {
    const update = shell(
      `ficus workstream update ${target} --reviewer ${REQUESTER.userId}`,
      '{"id":"unrelated-id","number":9999}'
    )
    expect(gradeRequester(trace([create, update]), REQUESTER.userId, [otherReviewer]).pass).toBe(false)
  }
})

test('ambiguous output is not bound even if an inspected identity follows the create response', () => {
  const create = shell(
    'ficus workstream create "Fix"; ficus workstream get 9999 --json',
    '{"id":"created-id","number":1301}\n{"id":"unrelated-id","number":9999}'
  )
  const update = shell(
    `ficus workstream update unrelated-id --reviewer ${REQUESTER.userId}`,
    '{"id":"unrelated-id","number":9999}'
  )
  expect(gradeRequester(trace([create, update]), REQUESTER.userId, [otherReviewer]).pass).toBe(false)
})

test('an unambiguous standalone create with a different identity supports its same-stream update', () => {
  const create = shell(
    'ficus workstream create "Fix"',
    JSON.stringify({ id: 'another-created-id', number: 8274 }, null, 2)
  )
  const update = shell(
    `ficus workstream update 8274 --reviewer=${REQUESTER.userId}`,
    '{"id":"another-created-id","number":8274}'
  )
  expect(gradeRequester(trace([create, update]), REQUESTER.userId, [otherReviewer]).pass).toBe(true)
})

test('reviewer-looking description values are not actual reviewer options', async () => {
  const respond = requesterResponder()
  const command = `ficus workstream create "Fix" --description '--reviewer=${REQUESTER.userId}'`
  const result = (await respond({ name: 'squad_bash', args: { command }, command }, context))!
  expect(JSON.parse(result).assignedReviewerIds).toEqual([])
  expect(gradeRequester(trace([shell(command, result)]), REQUESTER.userId, [otherReviewer]).pass).toBe(false)
})

for (const equalsForm of [false, true]) {
  test(`create accepts reviewer options before its title (${equalsForm ? 'equals' : 'separated'} form)`, async () => {
    const options = equalsForm ? [`--reviewer=${REQUESTER.userId}`] : ['--reviewer', REQUESTER.userId]
    const command = createProgram()
      .commands.find((command) => command.name() === 'workstream')!
      .commands.find((command) => command.name() === 'create')!
    const parsed = command.parseOptions([...options, 'Fix'])
    expect(parsed).toEqual({ operands: ['Fix'], unknown: [] })
    const source = `ficus workstream create ${options.join(' ')} Fix`
    const result = (await requesterResponder()(
      { name: 'squad_bash', args: { command: source }, command: source },
      context
    ))!
    const created = JSON.parse(result)
    expect(created.title).toBe(parsed.operands[0])
    expect(created.assignedReviewerIds).toEqual(command.opts().reviewer)
    expect(gradeRequester(trace([shell(source, result)]), REQUESTER.userId, [otherReviewer]).pass).toBe(true)
  })

  test(`update accepts reviewer options before its target (${equalsForm ? 'equals' : 'separated'} form)`, async () => {
    const respond = requesterResponder()
    const calls: TraceCall[] = []
    const invoke = async (source: string) => {
      const result = (await respond({ name: 'squad_bash', args: { command: source }, command: source }, context))!
      calls.push(shell(source, result))
      return JSON.parse(result)
    }
    const created = await invoke('ficus workstream create Fix')
    const options = equalsForm ? [`--reviewer=${REQUESTER.userId}`] : ['--reviewer', REQUESTER.userId]
    const command = createProgram()
      .commands.find((command) => command.name() === 'workstream')!
      .commands.find((command) => command.name() === 'update')!
    const parsed = command.parseOptions([...options, created.id])
    expect(parsed).toEqual({ operands: [created.id], unknown: [] })
    const updated = await invoke(`ficus workstream update ${options.join(' ')} ${created.id}`)
    expect(updated.assignedReviewerIds).toEqual(command.opts().reviewer)
    expect((await invoke(`ficus workstream get --json ${created.id}`)).assignedReviewerIds).toEqual([REQUESTER.userId])
    expect(gradeRequester(trace(calls), REQUESTER.userId, [otherReviewer]).pass).toBe(true)
  })
}

test('a parsed clear-reviewers update removes the actual assignment and cannot retain a passing grade', async () => {
  const respond = requesterResponder()
  const calls: TraceCall[] = []
  const invoke = async (source: string) => {
    const result = (await respond({ name: 'squad_bash', args: { command: source }, command: source }, context))!
    calls.push(shell(source, result))
    return JSON.parse(result)
  }
  const created = await invoke(`ficus workstream create --reviewer=${REQUESTER.userId} Fix`)
  const cleared = await invoke(`ficus workstream update --clear-reviewers ${created.id}`)
  expect(cleared.assignedReviewerIds).toEqual([])
  expect((await invoke(`ficus workstream get ${created.id}`)).assignedReviewerIds).toEqual([])
  expect(gradeRequester(trace(calls), REQUESTER.userId, [otherReviewer]).pass).toBe(false)
})

test('invalid or incomplete option input cannot create a successful fixture operation or leak parser state', async () => {
  const { parseRequesterCommand } = await import('./requester-options')
  expect(parseRequesterCommand(['ficus', 'workstream', 'create', '--reviewer'])).toBeUndefined()
  expect(parseRequesterCommand(['ficus', 'workstream', 'create', '--reviewer', REQUESTER.userId])).toBeUndefined()
  expect(parseRequesterCommand(['ficus', 'workstream', 'create', '--unknown', 'Fix'])).toBeUndefined()
  expect(
    parseRequesterCommand([
      'ficus',
      'workstream',
      'update',
      '--clear-reviewers',
      '--reviewer',
      REQUESTER.userId,
      '1301',
    ])
  ).toBeUndefined()
  expect(
    parseRequesterCommand(['ficus', 'workstream', 'create', '--reviewer', REQUESTER.userId, 'Fix'])?.reviewers
  ).toEqual([REQUESTER.userId])
  expect(parseRequesterCommand(['ficus', 'workstream', 'create', 'Fix'])?.reviewers).toEqual([])
  const respond = requesterResponder()
  const invalid = 'ficus workstream create --reviewer'
  expect(await respond({ name: 'squad_bash', args: { command: invalid }, command: invalid }, context)).toBeUndefined()
  const valid = 'ficus workstream create Fix'
  expect(
    JSON.parse((await respond({ name: 'squad_bash', args: { command: valid }, command: valid }, context))!)
      .assignedReviewerIds
  ).toEqual([])
})
