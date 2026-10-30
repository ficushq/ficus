import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { Command } from 'commander'
import type { IdleConsultant, IdleConsultantsPreview } from '@ficus/shared'
import { apiGet, apiPost } from '../client'
import { ApiRequestError } from '../client-errors'
import { output, outputError, setOutputOptions } from '../output'
import { registerSquadCommands } from './squad'
import {
  confirmOnTerminal,
  formatDormancyRun,
  formatIdleConsultantsPreview,
  parseIdleDays,
  runIdleConsultants,
  selectIdleConsultants,
} from './squad-idle-consultants'

const NOW = Date.parse('2026-10-30T12:00:00.000Z')
const SQUAD = 'aaaaaaaa-0000-4000-8000-000000000001'

/** Synthetic consultant with a predictable id: 1 -> 10000001-0000-4000-8000-000000000001. */
function consultant(n: number, overrides: Partial<IdleConsultant> = {}): IdleConsultant {
  const digits = String(n).padStart(7, '0')
  return {
    id: `1${digits}-0000-4000-8000-${String(n).padStart(12, '0')}`,
    label: `Consultant · Test ${n}`,
    status: 'idle',
    lastMessageAt: '2026-09-20T12:00:00.000Z',
    createdAt: '2026-08-01T12:00:00.000Z',
    bytes: 1024 ** 2,
    ...overrides,
  }
}

const apiGetMock = apiGet as ReturnType<typeof mock>
const apiPostMock = apiPost as ReturnType<typeof mock>
const outputMock = output as ReturnType<typeof mock>
const outputErrorMock = outputError as ReturnType<typeof mock>

function previewOf(agents: IdleConsultant[], days = 30): IdleConsultantsPreview {
  return { days, agents }
}

/** Echo the server: every requested id became dormant. */
function acceptAll() {
  apiPostMock.mockImplementation(async (_path: string, body: { agentIds: string[] }) => ({
    dormant: body.agentIds,
    deferred: [],
    skipped: [],
  }))
}

async function run(args: string[], squadEnv?: string): Promise<void> {
  const program = new Command()
  program.exitOverride()
  program.option('--json')
  program.option('--quiet')
  program.hook('preAction', (command) => setOutputOptions(command.optsWithGlobals()))
  registerSquadCommands(program)
  const previous = process.env.FICUS_SQUAD_ID
  if (squadEnv === undefined) delete process.env.FICUS_SQUAD_ID
  else process.env.FICUS_SQUAD_ID = squadEnv
  try {
    await program.parseAsync(args, { from: 'user' })
  } finally {
    if (previous === undefined) delete process.env.FICUS_SQUAD_ID
    else process.env.FICUS_SQUAD_ID = previous
  }
}

describe('squad idle-consultants CLI', () => {
  let stderr: ReturnType<typeof spyOn>

  beforeEach(() => {
    apiGetMock.mockReset()
    apiPostMock.mockReset()
    outputMock.mockClear()
    outputErrorMock.mockClear()
    stderr = spyOn(process.stderr, 'write').mockImplementation(() => true)
  })

  afterEach(() => {
    stderr.mockRestore()
    process.exitCode = 0
  })

  it('previews by default and never makes anything dormant', async () => {
    apiGetMock.mockResolvedValue(previewOf([consultant(1), consultant(2, { lastMessageAt: null, bytes: null })]))
    await run(['squad', 'idle-consultants'], SQUAD)
    expect(apiGetMock).toHaveBeenCalledWith(`/api/squads/${SQUAD}/idle-consultants`)
    expect(apiPostMock).not.toHaveBeenCalled()
    const [data, text] = outputMock.mock.calls[0]!
    expect(data).toMatchObject({ dryRun: true, days: 30 })
    expect((data as { agents: IdleConsultant[] }).agents).toHaveLength(2)
    expect(text).toContain(`2 consultants in squad ${SQUAD} idle for 30 days or more:`)
    expect(text).toContain('Preview only; nothing was changed. Add --make-dormant')
  })

  it('passes --days and an explicit, encoded squad id', async () => {
    apiGetMock.mockResolvedValue(previewOf([], 90))
    await run(['squad', 'idle-consultants', 'squad 1/x', '--days', '90'], SQUAD)
    expect(apiGetMock).toHaveBeenCalledWith('/api/squads/squad%201%2Fx/idle-consultants?days=90')
    expect(outputMock.mock.calls[0]![1]).toBe('No consultants in squad squad 1/x have been idle for 90 days or more.')
  })

  it('rejects invalid --days and --yes without --make-dormant before calling the API', async () => {
    await run(['squad', 'idle-consultants', '--days', '0'], SQUAD)
    await run(['squad', 'idle-consultants', '--days', '2.5'], SQUAD)
    await run(['squad', 'idle-consultants', '--yes'], SQUAD)
    expect(apiGetMock).not.toHaveBeenCalled()
    expect(outputErrorMock.mock.calls.map((call) => (call[0] as Error).message)).toEqual([
      '--days must be a whole number from 1 to 3650',
      '--days must be a whole number from 1 to 3650',
      '--yes only applies together with --make-dormant',
    ])
  })

  it('requires squad context', async () => {
    await run(['squad', 'idle-consultants'])
    expect(apiGetMock).not.toHaveBeenCalled()
    expect((outputErrorMock.mock.calls[0]![0] as Error).message).toContain('No squad context')
  })

  it('makes every previewed consultant dormant with --yes, in chunks of 25, using the previewed days', async () => {
    const agents = Array.from({ length: 30 }, (_, index) => consultant(index + 1))
    apiGetMock.mockResolvedValue(previewOf(agents, 45))
    acceptAll()
    await run(['squad', 'idle-consultants', '--days', '45', '--make-dormant', '--yes'], SQUAD)
    expect(apiPostMock).toHaveBeenCalledTimes(2)
    expect(apiPostMock.mock.calls[0]).toEqual([
      `/api/squads/${SQUAD}/idle-consultants/dormant`,
      { days: 45, agentIds: agents.slice(0, 25).map((agent) => agent.id) },
    ])
    expect(apiPostMock.mock.calls[1]![1]).toEqual({ days: 45, agentIds: agents.slice(25).map((agent) => agent.id) })
    const [data, text] = outputMock.mock.calls[0]!
    expect(data).toMatchObject({ dryRun: false, days: 45 })
    expect((data as { dormant: string[] }).dormant).toHaveLength(30)
    expect(text).toBe('Made 30 dormant.')
    expect(process.exitCode).toBe(0)
  })

  it('sends only the consultants selected with --agent', async () => {
    const agents = [consultant(1), consultant(2), consultant(3)]
    apiGetMock.mockResolvedValue(previewOf(agents))
    acceptAll()
    await run(
      [
        'squad',
        'idle-consultants',
        '--agent',
        agents[2]!.id.slice(0, 8),
        '--agent',
        agents[0]!.id,
        '--make-dormant',
        '-y',
      ],
      SQUAD
    )
    expect(apiPostMock.mock.calls[0]![1]).toEqual({ days: 30, agentIds: [agents[0]!.id, agents[2]!.id] })
  })

  it('refuses an --agent that is not in the idle preview and changes nothing', async () => {
    apiGetMock.mockResolvedValue(previewOf([consultant(1)]))
    await run(['squad', 'idle-consultants', '--agent', '99999999', '--make-dormant', '--yes'], SQUAD)
    expect(apiPostMock).not.toHaveBeenCalled()
    expect((outputErrorMock.mock.calls[0]![0] as Error).message).toContain('is not in the idle preview')
  })

  it('does nothing when there is nobody to make dormant', async () => {
    apiGetMock.mockResolvedValue(previewOf([]))
    const confirm = mock(() => true)
    expect(await runIdleConsultants(SQUAD, { makeDormant: true }, { confirm })).toBe(0)
    expect(confirm).not.toHaveBeenCalled()
    expect(apiPostMock).not.toHaveBeenCalled()
  })

  it('asks for confirmation without --yes and changes nothing when declined', async () => {
    apiGetMock.mockResolvedValue(previewOf([consultant(1), consultant(2)]))
    const confirm = mock(() => false)
    expect(await runIdleConsultants(SQUAD, { makeDormant: true }, { confirm })).toBe(0)
    expect(confirm).toHaveBeenCalledWith('Make 2 consultants dormant?')
    expect(stderr.mock.calls[0]![0]).toContain('2 consultants in squad')
    expect(apiPostMock).not.toHaveBeenCalled()
    expect(outputMock.mock.calls[0]).toEqual([
      expect.objectContaining({ dryRun: false, aborted: true }),
      'Aborted; nothing was changed.',
    ])
  })

  it('proceeds after a confirmed prompt and reports deferred and skipped consultants', async () => {
    const agents = [consultant(1), consultant(2), consultant(3)]
    apiGetMock.mockResolvedValue(previewOf(agents))
    apiPostMock.mockResolvedValue({
      dormant: [agents[0]!.id],
      deferred: [agents[1]!.id],
      skipped: [{ id: agents[2]!.id, reason: 'became active' }],
    })
    const confirm = mock(() => true)
    expect(await runIdleConsultants(SQUAD, { makeDormant: true }, { confirm })).toBe(0)
    expect(confirm).toHaveBeenCalledWith('Make 3 consultants dormant?')
    const text = outputMock.mock.calls[0]![1] as string
    expect(text).toContain('Made 1 dormant.')
    expect(text).toContain(`1 will become dormant after their current turn: ${agents[1]!.id}`)
    expect(text).toContain(`Left 1 unchanged:\n  ${agents[2]!.id}: became active`)
  })

  it('without a terminal, refuses to make anything dormant unless --yes is passed', async () => {
    expect(() => confirmOnTerminal('Make 1 consultant dormant?', false)).toThrow('pass --yes')
    apiGetMock.mockResolvedValue(previewOf([consultant(1)]))
    await expect(
      runIdleConsultants(SQUAD, { makeDormant: true }, { confirm: (question) => confirmOnTerminal(question, false) })
    ).rejects.toThrow('pass --yes')
    expect(apiPostMock).not.toHaveBeenCalled()
  })

  it('surfaces Forbidden plainly with the permission it needs', async () => {
    apiGetMock.mockRejectedValue(new ApiRequestError('Forbidden', 403))
    await run(['squad', 'idle-consultants', 'other-squad'])
    expect((outputErrorMock.mock.calls[0]![0] as Error).message).toBe(
      'Forbidden: idle consultants in squad other-squad can only be previewed or made dormant with the agents:terminate permission in that squad'
    )

    apiGetMock.mockResolvedValue(previewOf([consultant(1)]))
    apiPostMock.mockRejectedValue(new ApiRequestError('Forbidden', 403))
    await run(['squad', 'idle-consultants', 'other-squad', '--make-dormant', '--yes'])
    expect((outputErrorMock.mock.calls[1]![0] as Error).message).toStartWith('Forbidden: idle consultants')
  })

  it('passes other server errors through unchanged', async () => {
    apiGetMock.mockRejectedValue(new ApiRequestError('Squad not found', 404))
    await run(['squad', 'idle-consultants'], SQUAD)
    expect((outputErrorMock.mock.calls[0]![0] as Error).message).toBe('Squad not found')
  })

  it('keeps what succeeded when a later chunk fails, and exits non-zero', async () => {
    const agents = Array.from({ length: 26 }, (_, index) => consultant(index + 1))
    apiGetMock.mockResolvedValue(previewOf(agents))
    apiPostMock
      .mockImplementationOnce(async (_path: string, body: { agentIds: string[] }) => ({
        dormant: body.agentIds,
        deferred: [],
        skipped: [],
      }))
      .mockRejectedValueOnce(new ApiRequestError('Service unavailable', 503))
    await run(['squad', 'idle-consultants', '--make-dormant', '--yes'], SQUAD)
    const [data, text] = outputMock.mock.calls[0]!
    expect((data as { dormant: string[]; error: string }).dormant).toHaveLength(25)
    expect((data as { error: string }).error).toBe('Service unavailable')
    expect(text).toContain('Stopped early: Service unavailable. The remaining consultants were not changed.')
    expect(process.exitCode).toBe(1)
  })

  it('documents the permission, the preview default and the confirmation in help', () => {
    const program = new Command()
    registerSquadCommands(program)
    const command = program.commands
      .find((candidate) => candidate.name() === 'squad')
      ?.commands.find((candidate) => candidate.name() === 'idle-consultants')
    expect(command?.description()).toContain('agents:terminate')
    const help = command!.helpInformation()
    expect(help).toContain('[squad-id]')
    expect(help).toContain('--make-dormant')
    expect(help).toContain('--yes')
    expect(help).toContain('--agent <id>')
  })
})

describe('idle-consultants helpers', () => {
  it('parses days strictly', () => {
    expect(parseIdleDays(undefined)).toBeUndefined()
    expect(parseIdleDays('3650')).toBe(3650)
    for (const bad of ['0', '3651', '-1', 'abc', '1e2', ''])
      expect(() => parseIdleDays(bad)).toThrow('--days must be a whole number from 1 to 3650')
  })

  it('selects by full id or unique prefix and refuses short or ambiguous prefixes', () => {
    const agents = [consultant(1), consultant(2)]
    expect(selectIdleConsultants(agents, undefined)).toBe(agents)
    expect(selectIdleConsultants(agents, [agents[1]!.id.toUpperCase()])).toEqual([agents[1]!])
    expect(() => selectIdleConsultants(agents, ['1000'])).toThrow('at least 8 characters')
    const twins = [
      consultant(3, { id: 'abcdef12-0000-4000-8000-000000000001' }),
      consultant(4, { id: 'abcdef12-0000-4000-8000-000000000002' }),
    ]
    expect(() => selectIdleConsultants(twins, ['abcdef12'])).toThrow('matches 2 consultants')
  })

  it('formats the preview for people', () => {
    const text = formatIdleConsultantsPreview(
      SQUAD,
      30,
      [consultant(1), consultant(2, { lastMessageAt: null, bytes: null })],
      NOW
    )
    expect(text).toContain('  10000001  Consultant · Test 1  (last active 40d ago; box 1.0 MB)')
    expect(text).toContain('  10000002  Consultant · Test 2  (never messaged, created 90d ago; box not measured)')
    expect(text).toContain('Measured box size: 1.0 MB.')
    expect(text).toContain('history and files are kept')
  })

  it('formats a dormancy run with nothing left over', () => {
    expect(formatDormancyRun({ days: 30, dormant: ['a', 'b'], deferred: [], skipped: [] })).toBe('Made 2 dormant.')
  })
})
