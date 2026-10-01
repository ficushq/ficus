import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { Command } from 'commander'
import { apiDelete, apiGet, apiPatch, apiPost } from '../client'
import { isJsonMode, output, outputError, outputTable, setOutputOptions } from '../output'
import {
  buildWorkStreamSourceLinks,
  buildWorkStreamSpawnAgentBody,
  formatInvalidPriorityMessage,
  formatWorkStreamAgents,
  formatWorkStreamPriorityCell,
  formatWorkStreamPriorityDetail,
  getWorkStreamAgentTypes,
  isWorkStreamPriority,
  parseAgentModelOverrides,
  parseMemorySourceLink,
  registerWorkstreamCommands,
} from './workstream'

describe('workstream CLI commands', () => {
  beforeEach(() => {
    ;(apiGet as ReturnType<typeof mock>).mockClear()
    ;(apiPost as ReturnType<typeof mock>).mockClear()
    ;(apiPatch as ReturnType<typeof mock>).mockClear()
    ;(apiDelete as ReturnType<typeof mock>).mockClear()
    ;(output as ReturnType<typeof mock>).mockClear()
    ;(outputTable as ReturnType<typeof mock>).mockClear()
    ;(outputError as ReturnType<typeof mock>).mockClear()
    ;(isJsonMode as ReturnType<typeof mock>).mockReturnValue(false)
    ;(apiPost as ReturnType<typeof mock>).mockResolvedValue({
      id: '11111111-1111-1111-1111-111111111111',
      title: 'Implement feature',
    })
    ;(apiPatch as ReturnType<typeof mock>).mockResolvedValue({
      id: '22222222-2222-2222-2222-222222222222',
      title: 'Implement feature',
    })
  })

  afterEach(() => {
    mock.restore()
  })

  async function run(args: string[]): Promise<void> {
    const program = new Command()
    program.exitOverride()
    program.option('--json')
    program.option('--quiet')
    program.hook('preAction', (command) => setOutputOptions(command.optsWithGlobals()))
    registerWorkstreamCommands(program)
    await program.parseAsync(['--quiet', ...args], { from: 'user' })
  }

  it('preserves metadata lookup encoding, multiple criteria and legacy status filters', async () => {
    ;(apiGet as ReturnType<typeof mock>).mockResolvedValueOnce([])
    ;(isJsonMode as ReturnType<typeof mock>).mockReturnValue(true)
    await run([
      'workstream',
      'find-by-meta',
      '--match',
      'github.pr.number=42',
      '--match',
      "owner's=O'Reilly:books=α",
      '--status',
      'in_progress',
    ])
    const requestPath = (apiGet as ReturnType<typeof mock>).mock.calls[0][0] as string
    const url = new URL(requestPath, 'http://localhost')
    expect(url.pathname).toBe('/api/workstreams/by-metadata')
    expect(url.searchParams.getAll('match')).toEqual(['github.pr.number:42', "owner's:O'Reilly:books=α"])
    expect(url.searchParams.get('status')).toBe('active')
    expect(outputError).not.toHaveBeenCalled()
  })

  it('supports agent-only terminal observation without using user subscriptions', async () => {
    await run(['workstream', 'create', 'Observe result', '--squad', 'squad-1', '--observe', 'terminal'])
    expect(apiPost).toHaveBeenLastCalledWith('/api/workstreams', expect.objectContaining({ observe: 'terminal' }))
    await run(['workstream', 'observe', '#356'])
    expect(apiPost).toHaveBeenLastCalledWith('/api/workstreams/%23356/observe', { events: 'terminal' })
    await run(['workstream', 'observe', '#356', '--events', 'terminal'])
    expect(apiPost).toHaveBeenLastCalledWith('/api/workstreams/%23356/observe', { events: 'terminal' })
    await run(['workstream', 'observation', '#356'])
    expect(apiGet).toHaveBeenLastCalledWith('/api/workstreams/%23356/observation')
    await run(['workstream', 'unobserve', '#356'])
    expect(apiDelete).toHaveBeenLastCalledWith('/api/workstreams/%23356/observe')
  })

  it('inspects cleanup ownership and retains through the guarded lifecycle API', async () => {
    const inspection = {
      workStreamId: 'stream-1',
      owned: { worktree: '/original', branch: 'original', repository: '/repo' },
      current: { worktree: '/manual', branch: 'manual', repository: '/repo' },
      bindingsMatch: false,
      cleanup: null,
      recovery: 'retain',
    }
    ;(apiGet as ReturnType<typeof mock>).mockResolvedValue(inspection)
    ;(isJsonMode as ReturnType<typeof mock>).mockReturnValue(true)
    await run(['workstream', 'cleanup', 'inspect', '#228'])
    expect(apiGet).toHaveBeenLastCalledWith('/api/workstreams/%23228/worktree-cleanup')
    expect(output).toHaveBeenLastCalledWith(inspection)
    await run(['workstream', 'cleanup', 'retain', '#228'])
    expect(apiPatch).toHaveBeenLastCalledWith('/api/workstreams/%23228', { autoCleanupWorktree: false })
    ;(apiPatch as ReturnType<typeof mock>).mockRejectedValueOnce(new Error('Removal pending terminal proof'))
    await run(['workstream', 'cleanup', 'retain', '#228'])
    expect(outputError).toHaveBeenLastCalledWith(expect.objectContaining({ message: 'Removal pending terminal proof' }))
  })

  it('preserves cleanup opt-out and opt-in in create and update requests', async () => {
    for (const value of ['false', 'true']) {
      await run(['workstream', 'create', 'Cleanup test', '--squad', 'squad-1', '--auto-cleanup-worktree', value])
      expect(apiPost).toHaveBeenLastCalledWith(
        '/api/workstreams',
        expect.objectContaining({ autoCleanupWorktree: value === 'true' })
      )
      await run(['workstream', 'update', 'stream-1', '--auto-cleanup-worktree', value])
      expect(apiPatch).toHaveBeenLastCalledWith('/api/workstreams/stream-1', { autoCleanupWorktree: value === 'true' })
    }
  })

  it('rejects invalid cleanup booleans without sending a request', async () => {
    for (const value of ['0', '1', 'yes', 'FALSE']) {
      await run(['workstream', 'update', 'stream-1', '--auto-cleanup-worktree', value])
      await run(['workstream', 'create', 'Cleanup test', '--squad', 'squad-1', '--auto-cleanup-worktree', value])
    }
    expect(apiPost).not.toHaveBeenCalled()
    expect(apiPatch).not.toHaveBeenCalled()
    expect(outputError).toHaveBeenCalled()
  })

  it('pauses with a reason and optional parking deadline, then resumes explicitly', async () => {
    await run(['workstream', 'pause', 'stream-1', '--reason', 'Review direction', '--park-after', '5'])
    expect(apiPost).toHaveBeenCalledWith('/api/workstreams/stream-1/pause', {
      reason: 'Review direction',
      parkAfterMinutes: 5,
    })
    await run(['workstream', 'resume', 'stream-1'])
    expect(apiPost).toHaveBeenCalledWith('/api/workstreams/stream-1/resume')
  })

  it('keeps the slot by default and rejects invalid auto-park delays before sending', async () => {
    await run(['workstream', 'pause', 'stream-1'])
    expect(apiPost).toHaveBeenCalledWith('/api/workstreams/stream-1/pause', {})
    ;(apiPost as ReturnType<typeof mock>).mockClear()
    await run(['workstream', 'pause', 'stream-1', '--park-after', '0'])
    expect(apiPost).not.toHaveBeenCalled()
    expect(outputError).toHaveBeenCalled()
  })

  it('forwards provider identity and terminal context through one atomic CI settlement request', async () => {
    await run([
      'workstream',
      'notify-ci',
      'stream-1',
      'agent-1',
      '--repository',
      'acme/repo',
      '--workflow-id',
      '7',
      '--run-id',
      '100',
      '--run-number',
      '9',
      '--run-attempt',
      '10',
      '--conclusion',
      'failure',
      '--subject',
      'Synthetic CI',
      '--content',
      'Synthetic result',
    ])
    expect(apiPost).toHaveBeenCalledTimes(1)
    expect(apiPost).toHaveBeenCalledWith('/api/workstreams/stream-1/ci-notification', {
      recipientId: 'agent-1',
      repository: 'acme/repo',
      workflowId: '7',
      runId: '100',
      runNumber: '9',
      runAttempt: '10',
      conclusion: 'failure',
      subject: 'Synthetic CI',
      content: 'Synthetic result',
    })
    expect(apiPatch).not.toHaveBeenCalled()
  })

  describe('list', () => {
    it('keeps default table titles user-friendly by truncating long names', async () => {
      ;(apiGet as ReturnType<typeof mock>).mockResolvedValue([
        {
          id: '11111111-1111-1111-1111-111111111111',
          title: 'This is an exact long title that should be shortened in the default table',
          status: 'pending',
          squadId: 'squad-1',
          dependsOn: [],
        },
      ])

      await run(['workstream', 'list'])

      expect(outputTable).toHaveBeenCalledWith(
        [
          expect.objectContaining({
            Title: 'This is an exact long title th...',
          }),
        ],
        ['ID', 'Title', 'Status', 'Priority', 'Pos', 'Squad', 'Deps']
      )
    })

    it('preserves full titles in the table when --no-truncate is passed', async () => {
      const title = 'This is an exact long title that scripts can safely search for'
      ;(apiGet as ReturnType<typeof mock>).mockResolvedValue([
        {
          id: '11111111-1111-1111-1111-111111111111',
          title,
          status: 'pending',
          squadId: 'squad-1',
          dependsOn: [],
        },
      ])

      await run(['workstream', 'list', '--no-truncate'])

      expect(outputTable).toHaveBeenCalledWith(
        [
          expect.objectContaining({
            Title: title,
          }),
        ],
        ['ID', 'Title', 'Status', 'Priority', 'Pos', 'Squad', 'Deps']
      )
    })

    it('prints full work stream objects when JSON mode is enabled', async () => {
      const streams = [
        {
          id: '11111111-1111-1111-1111-111111111111',
          title: 'This is an exact long title for JSON consumers',
          status: 'pending',
          squadId: 'squad-1',
          dependsOn: [],
        },
      ]
      ;(isJsonMode as ReturnType<typeof mock>).mockReturnValue(true)
      ;(apiGet as ReturnType<typeof mock>).mockResolvedValue(streams)

      await run(['workstream', 'list', '--json'])

      expect(output).toHaveBeenCalledWith(streams)
      expect(outputTable).not.toHaveBeenCalled()
    })
  })

  describe('done', () => {
    it('passes --next-steps through to the update API body', async () => {
      await run([
        'workstream',
        'done',
        '22222222-2222-2222-2222-222222222222',
        '--next-steps',
        'Open a follow-up for docs',
      ])

      expect(apiPatch).toHaveBeenCalledWith('/api/workstreams/22222222-2222-2222-2222-222222222222', {
        status: 'done',
        nextSteps: 'Open a follow-up for docs',
      })
    })
  })

  describe('request-review', () => {
    it('omits completesOnApproval by default (server default = completes)', async () => {
      await run(['workstream', 'request-review', '11111111-1111-1111-1111-111111111111', '-m', 'please review'])

      expect(apiPost).toHaveBeenCalledWith('/api/workstreams/11111111-1111-1111-1111-111111111111/request-review', {
        message: 'please review',
      })
    })

    it('passes completesOnApproval:false when --no-complete is given', async () => {
      await run([
        'workstream',
        'request-review',
        '11111111-1111-1111-1111-111111111111',
        '-m',
        'mid-work checkpoint',
        '--no-complete',
      ])

      expect(apiPost).toHaveBeenCalledWith('/api/workstreams/11111111-1111-1111-1111-111111111111/request-review', {
        message: 'mid-work checkpoint',
        completesOnApproval: false,
      })
    })
  })

  describe('approve', () => {
    it('reports a checkpoint approval as continuing (stream not done)', async () => {
      ;(apiGet as ReturnType<typeof mock>).mockResolvedValue({
        id: '11111111-1111-1111-1111-111111111111',
        openWaits: [{ id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', type: 'review' }],
      })
      ;(apiPost as ReturnType<typeof mock>).mockResolvedValue({
        id: '11111111-1111-1111-1111-111111111111',
        status: 'active',
      })

      await run(['workstream', 'approve', '11111111-1111-1111-1111-111111111111', '-m', 'keep going'])

      expect(apiPost).toHaveBeenCalledWith(
        '/api/workstreams/11111111-1111-1111-1111-111111111111/waits/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/resolve',
        { resolution: 'approved', note: 'keep going' }
      )
      expect(output).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'active' }),
        expect.stringContaining('stream continues')
      )
    })

    it('reports a completing approval as done', async () => {
      ;(apiGet as ReturnType<typeof mock>).mockResolvedValue({
        id: '11111111-1111-1111-1111-111111111111',
        openWaits: [{ id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', type: 'review' }],
      })
      ;(apiPost as ReturnType<typeof mock>).mockResolvedValue({
        id: '11111111-1111-1111-1111-111111111111',
        status: 'done',
      })

      await run(['workstream', 'approve', '11111111-1111-1111-1111-111111111111'])

      expect(output).toHaveBeenCalledWith(expect.objectContaining({ status: 'done' }), expect.stringContaining('done'))
    })
  })

  describe('reopen', () => {
    it('POSTs to the reopen route and reports the admission outcome', async () => {
      ;(apiPost as ReturnType<typeof mock>).mockResolvedValue({
        id: '11111111-1111-1111-1111-111111111111',
        status: 'queued',
      })

      await run(['workstream', 'reopen', '11111111-1111-1111-1111-111111111111'])

      expect(apiPost).toHaveBeenCalledWith('/api/workstreams/11111111-1111-1111-1111-111111111111/reopen')
      expect(output).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'queued' }),
        expect.stringContaining('queued for admission')
      )
    })
  })

  describe('get wait history', () => {
    it('shows the effective cleanup opt-out and durable blocker', async () => {
      const logSpy = spyOn(console, 'log').mockImplementation(() => {})
      ;(isJsonMode as ReturnType<typeof mock>).mockReturnValue(false)
      ;(apiGet as ReturnType<typeof mock>).mockResolvedValue({
        id: '11111111-1111-1111-1111-111111111111',
        title: 'Retain evidence',
        status: 'done',
        squadId: 'sq-1',
        dependsOn: [],
        agentIds: [],
        autoCleanupWorktree: false,
        worktreeCleanup: {
          status: 'deferred',
          reason: 'Uncommitted changes: modified, staged or untracked (not ignored) files',
        },
      })
      try {
        await run(['workstream', 'get', '11111111-1111-1111-1111-111111111111'])
        const printed = logSpy.mock.calls.map((call) => String(call[0])).join('\n')
        expect(printed).toContain('Auto cleanup: disabled (retain worktree)')
        expect(printed).toContain(
          'Cleanup:     deferred — Uncommitted changes: modified, staged or untracked (not ignored) files'
        )
      } finally {
        logSpy.mockRestore()
      }
    })

    it('renders resolved waits with their resolution note (the audit trail)', async () => {
      const logSpy = spyOn(console, 'log').mockImplementation(() => {})
      ;(isJsonMode as ReturnType<typeof mock>).mockReturnValue(false)
      ;(apiGet as ReturnType<typeof mock>).mockResolvedValue({
        id: '11111111-1111-1111-1111-111111111111',
        title: 'Connect API phase 3',
        status: 'active',
        squadId: 'sq-1',
        dependsOn: [],
        agentIds: [],
        openWaits: [],
        waitHistory: [
          {
            id: 'cf02a4d2-91ad-4351-827a-419f05a7a55d',
            type: 'manual',
            message: 'need a decision',
            openedAt: '2026-08-24T20:00:00.000Z',
            closedAt: '2026-08-24T20:05:00.000Z',
            resolution: 'cleared',
            resolutionNote: 'use the compliant alternative',
          },
        ],
      })

      await run(['workstream', 'get', '11111111-1111-1111-1111-111111111111'])

      const printed = logSpy.mock.calls.map((call) => String(call[0])).join('\n')
      expect(printed).toContain('Wait history')
      expect(printed).toContain('[manual]')
      expect(printed).toContain('cleared')
      expect(printed).toContain('use the compliant alternative')
      logSpy.mockRestore()
    })
  })

  describe('get tracked resources', () => {
    it('prints tracked resource lines derived from metadata', async () => {
      const logSpy = spyOn(console, 'log').mockImplementation(() => {})
      ;(isJsonMode as ReturnType<typeof mock>).mockReturnValue(false)
      ;(apiGet as ReturnType<typeof mock>).mockResolvedValue({
        id: '11111111-1111-1111-1111-111111111111',
        title: 'Fix issue',
        status: 'active',
        squadId: 'sq-1',
        dependsOn: [],
        agentIds: [],
        metadata: {
          tracked: [{ integration: 'github', repository: 'acme/widgets', kind: 'issue', number: 12 }],
        },
      })

      await run(['workstream', 'get', '11111111-1111-1111-1111-111111111111'])

      const printed = logSpy.mock.calls.map((call) => String(call[0])).join('\n')
      expect(printed).toContain('  [issue] acme/widgets#12 (tracked) https://github.com/acme/widgets/issues/12')
      logSpy.mockRestore()
    })

    it('labels the primary delivery PR, flagged delivery PRs and plain links, with merge state when known', async () => {
      const logSpy = spyOn(console, 'log').mockImplementation(() => {})
      ;(isJsonMode as ReturnType<typeof mock>).mockReturnValue(false)
      ;(apiGet as ReturnType<typeof mock>).mockResolvedValue({
        id: '11111111-1111-1111-1111-111111111111',
        title: 'Fix issue',
        status: 'active',
        squadId: 'sq-1',
        dependsOn: [],
        agentIds: [],
        metadata: {
          codeHost: {
            integration: 'github',
            repository: 'acme/widgets',
            changeRequest: { number: 7 },
          },
          tracked: [
            { integration: 'github', repository: 'acme/widgets', kind: 'pull_request', number: 9, delivery: true },
            { integration: 'github', repository: 'acme/widgets', kind: 'issue', number: 12 },
          ],
          delivery: {
            pullRequests: {
              'github:acme/widgets:pull_request:7': { state: 'merged', at: '2026-09-14T10:00:00.000Z' },
              'github:acme/widgets:pull_request:9': { state: 'open', at: '2026-09-15T10:00:00.000Z' },
            },
          },
        },
      })

      await run(['workstream', 'get', '11111111-1111-1111-1111-111111111111'])

      const printed = logSpy.mock.calls.map((call) => String(call[0])).join('\n')
      expect(printed).toContain('  [pull_request] acme/widgets#7 (delivery PR, merged)')
      expect(printed).toContain('  [pull_request] acme/widgets#9 (delivery, open)')
      expect(printed).toContain('  [issue] acme/widgets#12 (tracked) https://github.com/acme/widgets/issues/12')
      logSpy.mockRestore()
    })

    it('labels a tracked Linear issue with its KEY-number reference', async () => {
      const logSpy = spyOn(console, 'log').mockImplementation(() => {})
      ;(isJsonMode as ReturnType<typeof mock>).mockReturnValue(false)
      ;(apiGet as ReturnType<typeof mock>).mockResolvedValue({
        id: '11111111-1111-1111-1111-111111111111',
        title: 'Fix issue',
        status: 'active',
        squadId: 'sq-1',
        dependsOn: [],
        agentIds: [],
        metadata: {
          tracked: [
            {
              integration: 'linear',
              repository: 'eng',
              kind: 'issue',
              number: 12,
              externalId: 'issue-uuid-1',
              url: 'https://linear.app/acme/issue/ENG-12/fix-thing',
            },
          ],
        },
      })

      await run(['workstream', 'get', '11111111-1111-1111-1111-111111111111'])

      const printed = logSpy.mock.calls.map((call) => String(call[0])).join('\n')
      expect(printed).toContain('  [issue] ENG-12 (tracked) https://linear.app/acme/issue/ENG-12/fix-thing')
      logSpy.mockRestore()
    })
  })

  describe('create', () => {
    it('does not emit human progress logs before created flow JSON', async () => {
      const logSpy = spyOn(console, 'log').mockImplementation(() => {})
      const created = {
        id: '11111111-1111-1111-1111-111111111111',
        title: 'Implement feature',
        status: 'pending',
        spawnedAgents: [
          { id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', agentTypeId: 'engineer', status: 'idle' },
          { id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', agentTypeId: 'reviewer', status: 'idle' },
        ],
      }
      ;(isJsonMode as ReturnType<typeof mock>).mockReturnValue(true)
      ;(apiPost as ReturnType<typeof mock>).mockResolvedValue(created)

      await run([
        'workstream',
        'create',
        'Implement feature',
        '--squad',
        'squad-1',
        '--workflow',
        'builder-reviewer',
        '--json',
      ])

      expect(logSpy).not.toHaveBeenCalled()
      expect(output).toHaveBeenCalledWith(created, 'Created work stream 11111111: Implement feature')
    })

    it('prints the created work stream as machine-readable JSON when JSON mode is enabled', async () => {
      const created = {
        id: '11111111-1111-1111-1111-111111111111',
        title: 'Implement feature',
        status: 'pending',
        metadata: { git: { branch: 'feature/workstream' } },
      }
      ;(isJsonMode as ReturnType<typeof mock>).mockReturnValue(true)
      ;(apiPost as ReturnType<typeof mock>).mockResolvedValue(created)

      await run(['workstream', 'create', 'Implement feature', '--squad', 'squad-1', '--json'])

      expect(output).toHaveBeenCalledWith(created, 'Created work stream 11111111: Implement feature')
    })

    it('passes git fields alongside a workflow', async () => {
      await run([
        'workstream',
        'create',
        'Implement feature',
        '--squad',
        'squad-1',
        '--repository',
        'repo',
        '--git-remote',
        'origin',
        '--branch',
        'feature/workstream',
        '--worktree',
        '/tmp/ficus-feature',
        '--base-branch',
        'main',
        '--workflow',
        'solo-coding',
      ])

      const body = (apiPost as ReturnType<typeof mock>).mock.calls[0][1]
      expect(apiPost).toHaveBeenCalledWith('/api/workstreams', expect.any(Object))
      expect(body).toEqual(
        expect.objectContaining({
          workflow: { kind: 'preset', id: 'solo-coding', customizations: [] },
          repository: 'repo',
          gitRemote: 'origin',
          branch: 'feature/workstream',
          worktree: '/tmp/ficus-feature',
          baseBranch: 'main',
        })
      )
    })

    it('passes --owner through to the create API body', async () => {
      await run(['workstream', 'create', 'Implement feature', '--squad', 'squad-1', '--owner', 'agent-1'])

      const body = (apiPost as ReturnType<typeof mock>).mock.calls[0][1]
      expect(apiPost).toHaveBeenCalledWith('/api/workstreams', expect.any(Object))
      expect(body).toEqual(expect.objectContaining({ ownerAgentId: 'agent-1' }))
    })

    it('passes source link flags in metadata.sources', async () => {
      await run([
        'workstream',
        'create',
        'Implement feature',
        '--squad',
        'squad-1',
        '--from-memory',
        'squad-2:/memory/foo.md',
        '--from-url',
        'https://example.com/context',
        '--from-slack',
        'https://acme.slack.com/archives/C0/p1700000000000000',
        '--source-link',
        '{"kind":"github_issue","url":"https://github.com/acme/repo/issues/1"}',
      ])

      const body = (apiPost as ReturnType<typeof mock>).mock.calls[0][1]
      expect(body.metadata.sources).toEqual([
        expect.objectContaining({ kind: 'github_issue', url: 'https://github.com/acme/repo/issues/1' }),
        expect.objectContaining({ kind: 'memory_document', sourceSquadId: 'squad-2', path: '/memory/foo.md' }),
        expect.objectContaining({ kind: 'url', url: 'https://example.com/context' }),
        expect.objectContaining({ kind: 'slack_thread', url: 'https://acme.slack.com/archives/C0/p1700000000000000' }),
      ])
    })

    it('omits completion and git fields from the create payload when flags are absent', async () => {
      await run(['workstream', 'create', 'Implement feature', '--squad', 'squad-1'])

      const body = (apiPost as ReturnType<typeof mock>).mock.calls[0][1]
      expect(apiPost).toHaveBeenCalledWith('/api/workstreams', expect.any(Object))
      expect(body).not.toHaveProperty('completionMode')
      expect(body).not.toHaveProperty('branch')
      expect(body).not.toHaveProperty('worktree')
      expect(body).not.toHaveProperty('baseBranch')
    })

    it('uses the squad default when no source is supplied', async () => {
      await run(['workstream', 'create', 'Task', '--squad', 'squad-1'])
      const body = (apiPost as ReturnType<typeof mock>).mock.calls[0][1]
      expect(body.workflow).toBeUndefined()
      for (const key of ['agents', 'agentIds', 'assigneeAgentId', 'assigneeAgentIndex', 'completionMode']) {
        expect(body).not.toHaveProperty(key)
      }
      expect(apiPost).toHaveBeenCalledTimes(1)
    })

    it('rejects removed creation flags before sending a request', async () => {
      for (const flag of [
        '--agents',
        '--agent-ids',
        '--assign-id',
        '--assign-index',
        '--model',
        '--agent-model',
        '--completion-mode',
      ]) {
        await expect(run(['workstream', 'create', 'Task', '--squad', 'squad-1', flag, 'legacy'])).rejects.toThrow(
          'unknown option'
        )
      }
      expect(apiPost).not.toHaveBeenCalled()
    })

    it('creates from an integration event and reports reuse when the event was already handled', async () => {
      const eventId = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'
      await run(['workstream', 'create', 'Fix bug', '--squad', 'squad-1', '--from-event', eventId])
      expect(apiPost).toHaveBeenLastCalledWith(
        '/api/workstreams',
        expect.objectContaining({ integrationEventId: eventId })
      )

      const reused = { id: 'stream-9', number: 9, title: 'Fix bug', reusedFromEvent: true }
      ;(apiPost as ReturnType<typeof mock>).mockResolvedValue(reused)
      await run(['workstream', 'create', 'Fix bug', '--squad', 'squad-1', '--from-event', eventId])
      expect(output).toHaveBeenLastCalledWith(reused, 'Reused existing work stream #9 for this event')
    })
  })

  describe('track', () => {
    it('tracks a GitHub issue given as owner/repo#number', async () => {
      await run(['workstream', 'track', 'stream-1', '--issue', 'acme/widgets#12'])
      expect(apiPost).toHaveBeenCalledWith('/api/workstreams/stream-1/tracked', {
        resource: { integration: 'github', repository: 'acme/widgets', kind: 'issue', number: 12 },
      })
    })

    it('tracks a GitHub pull request with a connection id', async () => {
      await run(['workstream', 'track', 'stream-1', '--pr', 'acme/widgets#7', '--connection', 'conn-1'])
      expect(apiPost).toHaveBeenCalledWith('/api/workstreams/stream-1/tracked', {
        resource: {
          integration: 'github',
          repository: 'acme/widgets',
          kind: 'pull_request',
          number: 7,
          connectionId: 'conn-1',
        },
      })
    })

    it('tracks by url', async () => {
      await run(['workstream', 'track', 'stream-1', '--url', 'https://github.com/acme/widgets/pull/7'])
      expect(apiPost).toHaveBeenCalledWith('/api/workstreams/stream-1/tracked', {
        url: 'https://github.com/acme/widgets/pull/7',
      })
    })

    it('tracks by integration event id', async () => {
      const eventId = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'
      await run(['workstream', 'track', 'stream-1', '--event', eventId])
      expect(apiPost).toHaveBeenCalledWith('/api/workstreams/stream-1/tracked', { event: eventId })
    })

    it('designates a pull request as a delivery change request', async () => {
      await run(['workstream', 'track', 'stream-1', '--pr', 'acme/widgets#7', '--delivery'])
      expect(apiPost).toHaveBeenCalledWith('/api/workstreams/stream-1/tracked', {
        resource: { integration: 'github', repository: 'acme/widgets', kind: 'pull_request', number: 7 },
        delivery: true,
      })
      ;(apiPost as ReturnType<typeof mock>).mockClear()

      await run(['workstream', 'track', 'stream-1', '--url', 'https://github.com/acme/widgets/pull/7', '--delivery'])
      expect(apiPost).toHaveBeenCalledWith('/api/workstreams/stream-1/tracked', {
        url: 'https://github.com/acme/widgets/pull/7',
        delivery: true,
      })
    })

    it('refuses to designate an issue or an event as delivery', async () => {
      await run(['workstream', 'track', 'stream-1', '--issue', 'acme/widgets#12', '--delivery'])
      expect(outputError).toHaveBeenLastCalledWith(new Error('--delivery applies to pull requests only'))

      await run(['workstream', 'track', 'stream-1', '--event', 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', '--delivery'])
      expect(outputError).toHaveBeenLastCalledWith(new Error('--delivery applies to pull requests only'))
      expect(apiPost).not.toHaveBeenCalled()
    })

    it('rejects an --issue reference that matches neither owner/repo#number nor KEY-123', async () => {
      await run(['workstream', 'track', 'stream-1', '--issue', 'not-a-valid-ref'])
      expect(apiPost).not.toHaveBeenCalled()
      expect(outputError).toHaveBeenCalledWith(new Error('Expected owner/repo#number or KEY-123'))
    })

    it('tracks a Linear issue given as KEY-123, sending a reference so the server can describe it', async () => {
      await run(['workstream', 'track', 'stream-1', '--issue', 'ENG-12'])
      expect(apiPost).toHaveBeenCalledWith('/api/workstreams/stream-1/tracked', { reference: 'ENG-12' })
    })

    it('keeps --connection on a Linear reference instead of silently dropping it', async () => {
      await run(['workstream', 'track', 'stream-1', '--issue', 'ENG-12', '--connection', 'conn-1'])
      expect(apiPost).toHaveBeenCalledWith('/api/workstreams/stream-1/tracked', {
        reference: 'ENG-12',
        connectionId: 'conn-1',
      })
    })

    it('tracks a Linear issue by its linear.app URL', async () => {
      await run(['workstream', 'track', 'stream-1', '--url', 'https://linear.app/acme/issue/ENG-12/fix-thing'])
      expect(apiPost).toHaveBeenCalledWith('/api/workstreams/stream-1/tracked', {
        url: 'https://linear.app/acme/issue/ENG-12/fix-thing',
      })
    })

    it('rejects --pr given a Linear reference', async () => {
      await run(['workstream', 'track', 'stream-1', '--pr', 'ENG-12'])
      expect(apiPost).not.toHaveBeenCalled()
      expect(outputError).toHaveBeenCalledWith(new Error('Linear references are issues; use --issue'))
    })

    it('refuses --delivery with a Linear issue reference or URL', async () => {
      await run(['workstream', 'track', 'stream-1', '--issue', 'ENG-12', '--delivery'])
      expect(outputError).toHaveBeenLastCalledWith(new Error('--delivery applies to pull requests only'))
      expect(apiPost).not.toHaveBeenCalled()

      await run([
        'workstream',
        'track',
        'stream-1',
        '--url',
        'https://linear.app/acme/issue/ENG-12/fix-thing',
        '--delivery',
      ])
      expect(outputError).toHaveBeenLastCalledWith(new Error('--delivery applies to pull requests only'))
      expect(apiPost).not.toHaveBeenCalled()
    })

    it('refuses --connection combined with --url or --event', async () => {
      await run([
        'workstream',
        'track',
        'stream-1',
        '--url',
        'https://github.com/acme/widgets/pull/7',
        '--connection',
        'conn-1',
      ])
      expect(outputError).toHaveBeenLastCalledWith(new Error('--connection applies to --issue and --pr only'))
      ;(outputError as ReturnType<typeof mock>).mockClear()

      await run([
        'workstream',
        'track',
        'stream-1',
        '--event',
        'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee',
        '--connection',
        'conn-1',
      ])
      expect(outputError).toHaveBeenLastCalledWith(new Error('--connection applies to --issue and --pr only'))
      expect(apiPost).not.toHaveBeenCalled()
    })

    it('rejects zero or multiple selectors', async () => {
      await run(['workstream', 'track', 'stream-1'])
      expect(outputError).toHaveBeenLastCalledWith(new Error('Choose exactly one of --event, --url, --issue, --pr'))
      ;(outputError as ReturnType<typeof mock>).mockClear()

      await run([
        'workstream',
        'track',
        'stream-1',
        '--url',
        'https://github.com/acme/widgets/pull/7',
        '--issue',
        'acme/widgets#12',
      ])
      expect(outputError).toHaveBeenLastCalledWith(new Error('Choose exactly one of --event, --url, --issue, --pr'))
      expect(apiPost).not.toHaveBeenCalled()
    })
  })

  describe('untrack', () => {
    it('untracks a pull request via DELETE with a resource body', async () => {
      await run(['workstream', 'untrack', 'stream-1', '--pr', 'acme/widgets#7', '--connection', 'conn-1'])
      expect(apiDelete).toHaveBeenCalledWith('/api/workstreams/stream-1/tracked', {
        resource: {
          integration: 'github',
          repository: 'acme/widgets',
          kind: 'pull_request',
          number: 7,
          connectionId: 'conn-1',
        },
      })
    })

    it('untracks by url', async () => {
      await run(['workstream', 'untrack', 'stream-1', '--url', 'https://github.com/acme/widgets/issues/12'])
      expect(apiDelete).toHaveBeenCalledWith('/api/workstreams/stream-1/tracked', {
        url: 'https://github.com/acme/widgets/issues/12',
      })
    })

    it('untracks a Linear issue given as KEY-123, sending a reference', async () => {
      await run(['workstream', 'untrack', 'stream-1', '--issue', 'ENG-12'])
      expect(apiDelete).toHaveBeenCalledWith('/api/workstreams/stream-1/tracked', { reference: 'ENG-12' })
    })

    it('keeps --connection on a Linear reference', async () => {
      await run(['workstream', 'untrack', 'stream-1', '--issue', 'ENG-12', '--connection', 'conn-1'])
      expect(apiDelete).toHaveBeenCalledWith('/api/workstreams/stream-1/tracked', {
        reference: 'ENG-12',
        connectionId: 'conn-1',
      })
    })

    it('rejects --pr given a Linear reference', async () => {
      await run(['workstream', 'untrack', 'stream-1', '--pr', 'ENG-12'])
      expect(apiDelete).not.toHaveBeenCalled()
      expect(outputError).toHaveBeenCalledWith(new Error('Linear references are issues; use --issue'))
    })

    it('rejects zero or multiple selectors', async () => {
      await run(['workstream', 'untrack', 'stream-1'])
      expect(outputError).toHaveBeenLastCalledWith(new Error('Choose exactly one of --url, --issue, --pr'))
      ;(outputError as ReturnType<typeof mock>).mockClear()

      await run(['workstream', 'untrack', 'stream-1', '--issue', 'acme/widgets#1', '--pr', 'acme/widgets#2'])
      expect(outputError).toHaveBeenLastCalledWith(new Error('Choose exactly one of --url, --issue, --pr'))
      expect(apiDelete).not.toHaveBeenCalled()
    })

    it('refuses --connection combined with --url', async () => {
      await run([
        'workstream',
        'untrack',
        'stream-1',
        '--url',
        'https://github.com/acme/widgets/pull/7',
        '--connection',
        'conn-1',
      ])
      expect(outputError).toHaveBeenLastCalledWith(new Error('--connection applies to --issue and --pr only'))
      expect(apiDelete).not.toHaveBeenCalled()
    })
  })

  describe('tracked', () => {
    it('renders tracked resources as a table with a subscriptions footer', async () => {
      const logSpy = spyOn(console, 'log').mockImplementation(() => {})
      ;(apiGet as ReturnType<typeof mock>).mockResolvedValue({
        resources: [
          {
            integration: 'github',
            repository: 'acme/widgets',
            kind: 'issue',
            number: 12,
            key: 'github:acme/widgets:issue:12',
            source: 'tracked',
            subscriptionIds: [],
            subscribed: true,
            delivery: false,
            url: 'https://github.com/acme/widgets/issues/12',
          },
        ],
        subscriptions: 'no-flow',
        delivery: { pullRequests: [], complete: false },
      })

      await run(['workstream', 'tracked', 'stream-1'])

      expect(apiGet).toHaveBeenCalledWith('/api/workstreams/stream-1/tracked')
      expect(outputTable).toHaveBeenCalledWith(
        [
          {
            Kind: 'issue',
            Resource: 'acme/widgets#12',
            Source: 'tracked',
            Delivery: '-',
            Merge: '-',
            Subscribed: 'yes',
            URL: 'https://github.com/acme/widgets/issues/12',
          },
        ],
        ['Kind', 'Resource', 'Source', 'Delivery', 'Merge', 'Subscribed', 'URL']
      )
      expect(logSpy).toHaveBeenCalledWith('Subscriptions: no-flow (attach a workflow)')
      // No delivery pull requests, so the stream has no delivery progress to report.
      expect(logSpy.mock.calls.map((call) => String(call[0])).join('\n')).not.toContain('Delivery:')
      logSpy.mockRestore()
    })

    it('shows delivery designation, merge state and delivery progress', async () => {
      const logSpy = spyOn(console, 'log').mockImplementation(() => {})
      const trackedView = (complete: boolean, secondState: 'open' | 'merged') => ({
        resources: [
          {
            integration: 'github',
            repository: 'acme/widgets',
            kind: 'pull_request',
            number: 7,
            key: 'github:acme/widgets:pull_request:7',
            source: 'delivery',
            delivery: true,
            subscriptionIds: ['sub-1'],
            subscribed: true,
            mergeState: 'merged',
            url: 'https://github.com/acme/widgets/pull/7',
          },
          {
            integration: 'github',
            repository: 'acme/widgets',
            kind: 'pull_request',
            number: 9,
            key: 'github:acme/widgets:pull_request:9',
            source: 'tracked',
            delivery: true,
            subscriptionIds: [],
            subscribed: false,
            mergeState: secondState,
            url: 'https://github.com/acme/widgets/pull/9',
          },
        ],
        subscriptions: 'active',
        delivery: {
          pullRequests: [
            {
              key: 'github:acme/widgets:pull_request:7',
              repository: 'acme/widgets',
              number: 7,
              primary: true,
              state: 'merged',
            },
            {
              key: 'github:acme/widgets:pull_request:9',
              repository: 'acme/widgets',
              number: 9,
              primary: false,
              state: secondState,
            },
          ],
          complete,
        },
      })
      ;(apiGet as ReturnType<typeof mock>).mockResolvedValue(trackedView(false, 'open'))

      await run(['workstream', 'tracked', 'stream-1'])

      expect(outputTable).toHaveBeenCalledWith(
        [
          {
            Kind: 'pull_request',
            Resource: 'acme/widgets#7',
            Source: 'delivery',
            Delivery: 'primary',
            Merge: 'merged',
            Subscribed: 'yes',
            URL: 'https://github.com/acme/widgets/pull/7',
          },
          {
            Kind: 'pull_request',
            Resource: 'acme/widgets#9',
            Source: 'tracked',
            Delivery: 'yes',
            Merge: 'open',
            Subscribed: 'no',
            URL: 'https://github.com/acme/widgets/pull/9',
          },
        ],
        ['Kind', 'Resource', 'Source', 'Delivery', 'Merge', 'Subscribed', 'URL']
      )
      expect(logSpy).toHaveBeenCalledWith('Delivery: 1/2 pull requests merged')
      ;(apiGet as ReturnType<typeof mock>).mockResolvedValue(trackedView(true, 'merged'))

      await run(['workstream', 'tracked', 'stream-1'])

      expect(logSpy).toHaveBeenCalledWith('Delivery: 2/2 pull requests merged (complete)')
      logSpy.mockRestore()
    })

    it('labels a Linear issue as KEY-number and shows - when no url is stored', async () => {
      ;(apiGet as ReturnType<typeof mock>).mockResolvedValue({
        resources: [
          {
            integration: 'linear',
            repository: 'eng',
            kind: 'issue',
            number: 12,
            externalId: 'issue-uuid-1',
            key: 'linear:eng:issue:12',
            source: 'tracked',
            subscriptionIds: [],
            subscribed: false,
            delivery: false,
          },
        ],
        subscriptions: 'active',
        delivery: { pullRequests: [], complete: false },
      })

      await run(['workstream', 'tracked', 'stream-1'])

      expect(outputTable).toHaveBeenCalledWith(
        [
          {
            Kind: 'issue',
            Resource: 'ENG-12',
            Source: 'tracked',
            Delivery: '-',
            Merge: '-',
            Subscribed: 'no',
            URL: '-',
          },
        ],
        ['Kind', 'Resource', 'Source', 'Delivery', 'Merge', 'Subscribed', 'URL']
      )
    })
  })

  describe('update', () => {
    it('passes completion and git fields in the update payload when flags are present', async () => {
      await run([
        'workstream',
        'update',
        'ws-1',
        '--repository',
        'repo',
        '--git-remote',
        'upstream',
        '--branch',
        'feature/workstream',
        '--worktree',
        '/tmp/ficus-feature',
        '--base-branch',
        'main',
        '--completion-mode',
        'direct-merge',
      ])

      const body = (apiPatch as ReturnType<typeof mock>).mock.calls[0][1]
      expect(apiPatch).toHaveBeenCalledWith('/api/workstreams/ws-1', expect.any(Object))
      expect(body).toEqual(
        expect.objectContaining({
          repository: 'repo',
          gitRemote: 'upstream',
          completionMode: 'direct-merge',
          branch: 'feature/workstream',
          worktree: '/tmp/ficus-feature',
          baseBranch: 'main',
        })
      )
    })

    it('passes -d through to the update API body as the description', async () => {
      await run(['workstream', 'update', 'ws-1', '-d', 'Updated description'])

      expect(apiPatch).toHaveBeenCalledWith(
        '/api/workstreams/ws-1',
        expect.objectContaining({ description: 'Updated description' })
      )
      expect(apiPost).not.toHaveBeenCalled()
    })

    it('passes --priority and repeatable --depends-on through to the update body', async () => {
      await run(['workstream', 'update', 'ws-1', '--priority', 'high', '--depends-on', 'ws-2', '--depends-on', 'ws-3'])

      expect(apiPatch).toHaveBeenCalledWith(
        '/api/workstreams/ws-1',
        expect.objectContaining({ priority: 'high', dependsOn: ['ws-2', 'ws-3'] })
      )
    })

    it('sets assigned reviewers from repeated flags', async () => {
      await run(['workstream', 'update', 'ws-1', '--reviewer', 'user-1', '--reviewer', 'user-2'])
      expect(apiPatch).toHaveBeenCalledWith(
        '/api/workstreams/ws-1',
        expect.objectContaining({ assignedReviewerIds: ['user-1', 'user-2'] })
      )
    })
    it('clears the reviewer filter explicitly', async () => {
      await run(['workstream', 'update', 'ws-1', '--clear-reviewers'])
      expect(apiPatch).toHaveBeenCalledWith(
        '/api/workstreams/ws-1',
        expect.objectContaining({ assignedReviewerIds: [] })
      )
    })
    it('rejects contradictory reviewer flags without a request', async () => {
      await run(['workstream', 'update', 'ws-1', '--clear-reviewers', '--reviewer', 'user-1'])
      expect(apiPatch).not.toHaveBeenCalled()
      expect(outputError).toHaveBeenCalledWith(
        expect.objectContaining({ message: expect.stringContaining('mutually exclusive') })
      )
    })

    it('sends dependsOn: [] when --clear-dependencies is passed', async () => {
      await run(['workstream', 'update', 'ws-1', '--clear-dependencies'])

      const body = (apiPatch as ReturnType<typeof mock>).mock.calls[0][1] as Record<string, unknown>
      expect(apiPatch).toHaveBeenCalledWith('/api/workstreams/ws-1', expect.any(Object))
      expect(body.dependsOn).toEqual([])
    })

    it('treats --remove-dependency as an alias that sends dependsOn: []', async () => {
      await run(['workstream', 'update', 'ws-1', '--remove-dependency'])

      const body = (apiPatch as ReturnType<typeof mock>).mock.calls[0][1] as Record<string, unknown>
      expect(apiPatch).toHaveBeenCalledWith('/api/workstreams/ws-1', expect.any(Object))
      expect(body.dependsOn).toEqual([])
    })

    it('rejects --clear-dependencies combined with --depends-on before making any request', async () => {
      const exitSpy = spyOn(process, 'exit').mockImplementation(((code?: string | number | null) => {
        throw new Error(`process.exit ${code}`)
      }) as typeof process.exit)

      await run(['workstream', 'update', 'ws-1', '--clear-dependencies', '--depends-on', 'ws-2'])

      expect(outputError).toHaveBeenCalledWith(
        expect.objectContaining({ message: expect.stringContaining('mutually exclusive') })
      )
      expect(exitSpy).toHaveBeenCalledWith(1)
      expect(apiPatch).not.toHaveBeenCalled()
    })

    it('rejects --remove-dependency combined with --depends-on before making any request', async () => {
      const exitSpy = spyOn(process, 'exit').mockImplementation(((code?: string | number | null) => {
        throw new Error(`process.exit ${code}`)
      }) as typeof process.exit)

      await run(['workstream', 'update', 'ws-1', '--remove-dependency', '--depends-on', 'ws-2'])

      expect(outputError).toHaveBeenCalledWith(
        expect.objectContaining({ message: expect.stringContaining('mutually exclusive') })
      )
      expect(exitSpy).toHaveBeenCalledWith(1)
      expect(apiPatch).not.toHaveBeenCalled()
    })

    it('replaces the whole dependency list with repeated --depends-on values', async () => {
      await run([
        'workstream',
        'update',
        'ws-1',
        '--depends-on',
        'ws-2',
        '--depends-on',
        'ws-3',
        '--depends-on',
        'ws-4',
      ])

      const body = (apiPatch as ReturnType<typeof mock>).mock.calls[0][1] as Record<string, unknown>
      expect(body.dependsOn).toEqual(['ws-2', 'ws-3', 'ws-4'])
    })

    it('omits dependsOn from the update payload when no dependency flags are passed', async () => {
      await run(['workstream', 'update', 'ws-1', '--title', 'New title'])

      const body = (apiPatch as ReturnType<typeof mock>).mock.calls[0][1] as Record<string, unknown>
      expect('dependsOn' in body).toBe(false)
    })

    it('passes --owner through to the update API body', async () => {
      await run(['workstream', 'update', 'ws-1', '--owner', 'agent-1'])

      expect(apiPatch).toHaveBeenCalledWith(
        '/api/workstreams/ws-1',
        expect.objectContaining({ ownerAgentId: 'agent-1' })
      )
      expect(apiPost).not.toHaveBeenCalled()
    })

    it('passes --clear-owner through to the update API body', async () => {
      await run(['workstream', 'update', 'ws-1', '--clear-owner'])

      expect(apiPatch).toHaveBeenCalledWith('/api/workstreams/ws-1', expect.objectContaining({ ownerAgentId: null }))
      expect(apiPost).not.toHaveBeenCalled()
    })

    it('accepts pr-auto-merge as an update completion mode', async () => {
      await run(['workstream', 'update', 'ws-1', '--completion-mode', 'pr-auto-merge'])

      const body = (apiPatch as ReturnType<typeof mock>).mock.calls[0][1]
      expect(body).toEqual(expect.objectContaining({ completionMode: 'pr-auto-merge' }))
    })

    it('omits completion and git fields from the update payload when flags are absent', async () => {
      await run(['workstream', 'update', 'ws-1', '--status', 'in_progress'])

      const body = (apiPatch as ReturnType<typeof mock>).mock.calls[0][1]
      expect(apiPatch).toHaveBeenCalledWith('/api/workstreams/ws-1', expect.any(Object))
      expect(body).toEqual(expect.objectContaining({ status: 'in_progress' }))
      expect(body).not.toHaveProperty('completionMode')
      expect(body).not.toHaveProperty('branch')
      expect(body).not.toHaveProperty('worktree')
      expect(body).not.toHaveProperty('baseBranch')
    })

    it('rejects invalid completion modes before updating a work stream', async () => {
      const exitSpy = spyOn(process, 'exit').mockImplementation(((code?: string | number | null) => {
        throw new Error(`process.exit ${code}`)
      }) as typeof process.exit)

      await run(['workstream', 'update', 'ws-1', '--completion-mode', 'invalid'])

      expect(outputError).toHaveBeenCalledWith(
        expect.objectContaining({
          message:
            'Invalid --completion-mode: invalid. Must be one of: pr-merge, pr-auto-merge, review-approval, direct-merge, deliverable',
        })
      )
      expect(exitSpy).toHaveBeenCalledWith(1)
      expect(apiPatch).not.toHaveBeenCalled()
    })
  })

  describe('priority', () => {
    it('passes --priority through on create', async () => {
      await run(['workstream', 'create', 'Prioritized', '--squad', 'squad-1', '--priority', 'critical'])

      expect(apiPost).toHaveBeenCalledWith(
        '/api/workstreams',
        expect.objectContaining({ title: 'Prioritized', priority: 'critical' })
      )
    })

    it('omits priority from the create body when the flag is absent', async () => {
      await run(['workstream', 'create', 'Default prio', '--squad', 'squad-1'])

      const body = (apiPost as ReturnType<typeof mock>).mock.calls[0][1] as Record<string, unknown>
      expect('priority' in body).toBe(false)
    })

    it('validates priorities and formats helpful errors', () => {
      expect(isWorkStreamPriority('critical')).toBe(true)
      expect(isWorkStreamPriority('urgent')).toBe(false)
      const message = formatInvalidPriorityMessage('urgent')
      for (const level of ['critical', 'high', 'normal', 'low']) {
        expect(message).toContain(level)
      }
    })

    it('formats table and detail priority forms, showing boosts', () => {
      expect(formatWorkStreamPriorityCell({ priority: 'normal' })).toBe('normal')
      expect(formatWorkStreamPriorityCell({ priority: 'low', effectivePriority: 'high' })).toBe('low→high')
      expect(formatWorkStreamPriorityDetail({ priority: 'low' })).toBe('low')
      expect(
        formatWorkStreamPriorityDetail({
          priority: 'low',
          effectivePriority: 'high',
          effectivePriorityVia: 'Feature X',
        })
      ).toBe('low (effective: high via Feature X)')
    })
  })

  describe('direct handoff', () => {
    it('preserves queued status and reports pending admission', async () => {
      ;(apiPatch as ReturnType<typeof mock>).mockResolvedValue({
        id: '12345678-0000-0000-0000-000000000000',
        title: 'Queued',
        status: 'queued',
      })
      await run(['workstream', 'handoff', 'ws-1', '--to', 'agent-2', '-m', 'Review'])
      const body = (apiPatch as ReturnType<typeof mock>).mock.calls[0][1] as Record<string, unknown>
      expect(Object.keys(body)).not.toContain('status')
      expect(body.assigneeAgentId).toBe('agent-2')
      expect(output).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'queued' }),
        expect.stringContaining('pending admission')
      )
    })

    it('reports an admitted handoff without pending wording', async () => {
      ;(apiPatch as ReturnType<typeof mock>).mockResolvedValue({
        id: '12345678-0000-0000-0000-000000000000',
        title: 'Active',
        status: 'active',
      })
      await run(['workstream', 'handoff', 'ws-1', '--to', 'agent-2', '-m', 'Review'])
      expect(output).toHaveBeenCalledWith(expect.anything(), 'Work stream 12345678 handed off to agent-2')
    })

    it('handoff without --to errors and points at request-review (no review wait opened)', async () => {
      await run(['workstream', 'handoff', 'ws-1', '-m', 'done for now'])
      expect(apiPost).not.toHaveBeenCalled()
      expect(apiPatch).not.toHaveBeenCalled()
      expect(outputError).toHaveBeenCalledWith(
        expect.objectContaining({ message: expect.stringContaining('request-review') })
      )
    })
  })

  describe('wait verbs (typed resolution sugar)', () => {
    const wsId = '12345678-0000-0000-0000-000000000000'

    it('request-input opens a manual wait via the new route', async () => {
      await run(['workstream', 'request-input', 'ws-1', '-m', 'need credentials'])
      expect(apiPost).toHaveBeenCalledWith('/api/workstreams/ws-1/request-input', { message: 'need credentials' })
    })

    it('request-input forwards a validated --actor', async () => {
      for (const actor of ['human', 'owner']) {
        ;(apiPost as ReturnType<typeof mock>).mockClear()
        await run(['workstream', 'request-input', 'ws-1', '-m', 'hold', '--actor', actor])
        expect(apiPost).toHaveBeenCalledWith('/api/workstreams/ws-1/request-input', { message: 'hold', actor })
      }
    })

    it('request-input rejects an unknown --actor before calling the API', async () => {
      ;(apiPost as ReturnType<typeof mock>).mockClear()
      for (const actor of ['robot', 'manager', 'external']) {
        await expect(run(['workstream', 'request-input', 'ws-1', '-m', 'hold', '--actor', actor])).rejects.toThrow()
      }
      expect(apiPost).not.toHaveBeenCalled()
    })

    it('wait-actor relabels the single open manual wait with an audit note', async () => {
      ;(apiGet as ReturnType<typeof mock>).mockResolvedValue({
        id: wsId,
        openWaits: [{ id: 'wait-manual-1', type: 'manual', actor: 'human', message: 'hold' }],
      })
      ;(apiPost as ReturnType<typeof mock>).mockResolvedValue({ id: wsId, title: 'T', changed: true })
      await run(['workstream', 'wait-actor', 'ws-1', 'owner', '-m', 'owner-held hold'])
      expect(apiPost).toHaveBeenCalledWith(`/api/workstreams/${wsId}/waits/wait-manual-1/actor`, {
        actor: 'owner',
        note: 'owner-held hold',
      })
    })

    it('wait-actor rejects an unknown actor without calling the API', async () => {
      ;(apiPost as ReturnType<typeof mock>).mockClear()
      await run(['workstream', 'wait-actor', 'ws-1', 'manager'])
      expect(apiPost).not.toHaveBeenCalled()
      expect(outputError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('manager') }))
    })

    it('request-review opens the review wait via the new route', async () => {
      ;(apiPost as ReturnType<typeof mock>).mockResolvedValue({ id: wsId, title: 'R', alreadyOpen: false })
      await run(['workstream', 'request-review', 'ws-1', '-m', 'please review'])
      expect(apiPost).toHaveBeenCalledWith('/api/workstreams/ws-1/request-review', { message: 'please review' })
    })

    it('approve resolves the single open review wait through the typed endpoint', async () => {
      ;(apiGet as ReturnType<typeof mock>).mockResolvedValue({
        id: wsId,
        openWaits: [{ id: 'wait-review-1', type: 'review', message: 'round one' }],
      })
      ;(apiPost as ReturnType<typeof mock>).mockResolvedValue({ id: wsId, status: 'done' })

      await run(['workstream', 'approve', 'ws-1'])

      expect(apiPost).toHaveBeenCalledWith(`/api/workstreams/${wsId}/waits/wait-review-1/resolve`, {
        resolution: 'approved',
      })
    })

    it('send-back resolves with sent_back and the note', async () => {
      ;(apiGet as ReturnType<typeof mock>).mockResolvedValue({
        id: wsId,
        openWaits: [{ id: 'wait-review-1', type: 'review', message: null }],
      })
      ;(apiPost as ReturnType<typeof mock>).mockResolvedValue({ id: wsId, status: 'active' })

      await run(['workstream', 'send-back', 'ws-1', '--note', 'needs tests'])

      expect(apiPost).toHaveBeenCalledWith(`/api/workstreams/${wsId}/waits/wait-review-1/resolve`, {
        resolution: 'sent_back',
        note: 'needs tests',
      })
    })

    it('send-back accepts the canonical -m flag (flag parity with the other verbs)', async () => {
      ;(apiGet as ReturnType<typeof mock>).mockResolvedValue({
        id: wsId,
        openWaits: [{ id: 'wait-review-1', type: 'review', message: null }],
      })
      ;(apiPost as ReturnType<typeof mock>).mockResolvedValue({ id: wsId, status: 'active' })

      await run(['workstream', 'send-back', 'ws-1', '-m', 'needs tests'])

      expect(apiPost).toHaveBeenCalledWith(`/api/workstreams/${wsId}/waits/wait-review-1/resolve`, {
        resolution: 'sent_back',
        note: 'needs tests',
      })
    })

    it('approve accepts --note as an alias for -m/--message', async () => {
      ;(apiGet as ReturnType<typeof mock>).mockResolvedValue({
        id: wsId,
        openWaits: [{ id: 'wait-review-1', type: 'review', message: null }],
      })
      ;(apiPost as ReturnType<typeof mock>).mockResolvedValue({ id: wsId, status: 'done' })

      await run(['workstream', 'approve', 'ws-1', '--note', 'ship it'])

      expect(apiPost).toHaveBeenCalledWith(`/api/workstreams/${wsId}/waits/wait-review-1/resolve`, {
        resolution: 'approved',
        note: 'ship it',
      })
    })

    it('unblock resolves the single open manual wait with the note', async () => {
      ;(apiGet as ReturnType<typeof mock>).mockResolvedValue({
        id: wsId,
        openWaits: [{ id: 'wait-manual-1', type: 'manual', message: 'need input' }],
      })
      ;(apiPost as ReturnType<typeof mock>).mockResolvedValue({ id: wsId, status: 'active' })

      await run(['workstream', 'unblock', 'ws-1', '-m', 'here you go'])

      expect(apiPost).toHaveBeenCalledWith(`/api/workstreams/${wsId}/waits/wait-manual-1/resolve`, {
        resolution: 'cleared',
        note: 'here you go',
      })
    })

    it('unblock with several open manual waits refuses and requires --wait', async () => {
      ;(apiGet as ReturnType<typeof mock>).mockResolvedValue({
        id: wsId,
        openWaits: [
          { id: 'wait-manual-1', type: 'manual', message: 'first' },
          { id: 'wait-manual-2', type: 'manual', message: 'second' },
        ],
      })

      await run(['workstream', 'unblock', 'ws-1'])

      expect(apiPost).not.toHaveBeenCalled()
      expect(outputError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('--wait') }))
    })

    it('unblock --wait targets the named wait among several', async () => {
      ;(apiGet as ReturnType<typeof mock>).mockResolvedValue({
        id: wsId,
        openWaits: [
          { id: 'wait-manual-1', type: 'manual', message: 'first' },
          { id: 'wait-manual-2', type: 'manual', message: 'second' },
        ],
      })
      ;(apiPost as ReturnType<typeof mock>).mockResolvedValue({ id: wsId, status: 'active' })

      await run(['workstream', 'unblock', 'ws-1', '--wait', 'wait-manual-2'])

      expect(apiPost).toHaveBeenCalledWith(`/api/workstreams/${wsId}/waits/wait-manual-2/resolve`, {
        resolution: 'cleared',
      })
    })

    it('unblock resolves the named open wait reliably with the observed ~1400-char note (both command spellings)', async () => {
      const longNote = 'x'.repeat(1400)
      for (const spelling of ['workstream', 'ws'] as const) {
        ;(apiGet as ReturnType<typeof mock>).mockClear()
        ;(apiPost as ReturnType<typeof mock>).mockClear()
        ;(apiGet as ReturnType<typeof mock>).mockResolvedValue({
          id: wsId,
          openWaits: [{ id: 'wait-manual-1', type: 'manual', message: 'need input' }],
        })
        ;(apiPost as ReturnType<typeof mock>).mockResolvedValue({ id: wsId, status: 'active' })

        await run([spelling, 'unblock', 'ws-1', '--wait', 'wait-manual-1', '-m', longNote])

        expect(apiPost).toHaveBeenCalledWith(`/api/workstreams/${wsId}/waits/wait-manual-1/resolve`, {
          resolution: 'cleared',
          note: longNote,
        })
      }
    })

    it('unblock carries a multibyte note byte-exactly (characters, not UTF-16 units or bytes, are the unit)', async () => {
      const emojiNote = '🎉'.repeat(700)
      ;(apiGet as ReturnType<typeof mock>).mockResolvedValue({
        id: wsId,
        openWaits: [{ id: 'wait-manual-1', type: 'manual', message: 'need input' }],
      })
      ;(apiPost as ReturnType<typeof mock>).mockResolvedValue({ id: wsId, status: 'active' })

      await run(['workstream', 'unblock', 'ws-1', '-m', emojiNote])

      expect(apiPost).toHaveBeenCalledWith(`/api/workstreams/${wsId}/waits/wait-manual-1/resolve`, {
        resolution: 'cleared',
        note: emojiNote,
      })
    })

    it('unblock --wait naming an already-closed wait fails loudly with the stale-target diagnosis and never POSTs', async () => {
      ;(apiGet as ReturnType<typeof mock>).mockResolvedValue({
        id: wsId,
        openWaits: [{ id: 'wait-open-1', type: 'manual', message: 'still waiting' }],
        waitHistory: [
          {
            id: 'wait-stale-1',
            type: 'manual',
            message: 'need input',
            closedAt: '2026-09-02T23:07:59.000Z',
            resolution: 'cleared',
            resolutionNote: 'Execution 8f2c started for the current assignee.',
          },
          { id: 'wait-open-1', type: 'manual', message: 'still waiting' },
        ],
      })

      await run(['ws', 'unblock', 'ws-1', '--wait', 'wait-stale-1', '-m', 'x'.repeat(1400)])

      expect(apiPost).not.toHaveBeenCalled()
      expect(outputError).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringMatching(/already closed/i),
        })
      )
      const message = (outputError as ReturnType<typeof mock>).mock.calls[0][0].message as string
      expect(message).toContain('wait-stale-1')
      expect(message).toContain('cleared')
      expect(message).toMatch(/note was not recorded/i)
      expect(message).toContain('wait-open-1')
    })

    it('approve --wait naming an already-closed review wait gets the same shared-path diagnosis', async () => {
      ;(apiGet as ReturnType<typeof mock>).mockResolvedValue({
        id: wsId,
        openWaits: [],
        waitHistory: [
          {
            id: 'wait-review-closed',
            type: 'review',
            message: null,
            closedAt: '2026-09-02T23:07:59.000Z',
            resolution: 'approved',
            resolutionNote: 'ship it',
          },
        ],
      })

      await run(['workstream', 'approve', 'ws-1', '--wait', 'wait-review-closed', '-m', 'ok'])

      expect(apiPost).not.toHaveBeenCalled()
      expect(outputError).toHaveBeenCalledWith(
        expect.objectContaining({ message: expect.stringMatching(/already closed/i) })
      )
    })

    it('the legacy respond and review commands are gone', () => {
      const program = new Command()
      registerWorkstreamCommands(program)
      const workstream = program.commands.find((command) => command.name() === 'workstream')!
      const names = workstream.commands.flatMap((command) => [command.name(), ...command.aliases()])
      expect(names).not.toContain('respond')
      expect(names).not.toContain('review')
      expect(names).not.toContain('block')
      expect(names).toContain('request-input')
      expect(names).toContain('request-review')
    })
  })

  describe('park', () => {
    it('maps park to POST /api/workstreams/:id/park', async () => {
      ;(apiPost as ReturnType<typeof mock>).mockResolvedValue({
        id: '33333333-3333-3333-3333-333333333333',
        title: 'Parked stream',
        status: 'queued',
        queuePosition: 2,
      })

      await run(['workstream', 'park', 'ws-1'])

      expect(apiPost).toHaveBeenCalledWith('/api/workstreams/ws-1/park')
      expect(output).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'queued' }),
        expect.stringContaining('queue position 2')
      )
    })

    it('forwards --preempt-running explicitly', async () => {
      ;(apiPost as ReturnType<typeof mock>).mockResolvedValue({
        id: '33333333-3333-3333-3333-333333333333',
        title: 'Preempted stream',
        status: 'queued',
      })

      // Mutation: dropping the option forwarding must lose this request body.
      await run(['workstream', 'park', 'ws-1', '--preempt-running'])
      expect(apiPost).toHaveBeenCalledWith('/api/workstreams/ws-1/park', { preemptRunning: true })
    })

    it('teaches the stop-first procedure in park help', () => {
      const program = new Command()
      registerWorkstreamCommands(program)
      const workstream = program.commands.find((command) => command.name() === 'workstream')!
      const park = workstream.commands.find((command) => command.name() === 'park')!
      const help = park.helpInformation()

      expect(help).toContain('ask the running agent to stop')
      expect(help).toContain('wait for confirmation')
      expect(help).toContain('--preempt-running')
    })

    it('warns when the park was a no-op (stream immediately re-admitted)', async () => {
      ;(apiPost as ReturnType<typeof mock>).mockResolvedValue({
        id: '44444444-4444-4444-4444-444444444444',
        title: 'Boomerang stream',
        status: 'pending',
        reAdmitted: true,
      })

      await run(['workstream', 'park', 'ws-2'])

      expect(output).toHaveBeenCalledWith(
        expect.objectContaining({ reAdmitted: true }),
        expect.stringContaining('immediately re-admitted')
      )
    })
  })

  describe('source link parsing', () => {
    it('converts --from-memory values to memory_document source links', () => {
      expect(parseMemorySourceLink('squad-id:/memory/foo.md')).toEqual(
        expect.objectContaining({
          kind: 'memory_document',
          sourceSquadId: 'squad-id',
          path: '/memory/foo.md',
          addedAt: expect.any(String),
        })
      )
    })

    it('builds source links from shortcuts and JSON', () => {
      expect(
        buildWorkStreamSourceLinks({
          sourceLink: ['{"kind":"linear_issue","sourceId":"LIN-1"}'],
          fromMemory: 'squad-id:/memory/foo.md',
          fromUrl: ['https://example.com'],
          fromSlack: ['https://acme.slack.com/archives/C0/p1'],
        })
      ).toEqual([
        expect.objectContaining({ kind: 'linear_issue', sourceId: 'LIN-1' }),
        expect.objectContaining({ kind: 'memory_document', sourceSquadId: 'squad-id', path: '/memory/foo.md' }),
        expect.objectContaining({ kind: 'url', url: 'https://example.com' }),
        expect.objectContaining({ kind: 'slack_thread', url: 'https://acme.slack.com/archives/C0/p1' }),
      ])
    })
  })

  describe('getWorkStreamAgentTypes', () => {
    it('returns an agent id to type mapping for JSON output', () => {
      const engineerId = '11111111-1111-1111-1111-111111111111'
      const missingId = '22222222-2222-2222-2222-222222222222'
      const summaries = new Map([
        [engineerId, { id: engineerId, agentTypeId: 'engineer', metadata: null, status: 'idle' }],
        [missingId, null],
      ])

      expect(getWorkStreamAgentTypes([engineerId, missingId], summaries)).toEqual({
        [engineerId]: 'engineer',
        [missingId]: 'unknown',
      })
    })
  })

  describe('buildWorkStreamSpawnAgentBody', () => {
    it('omits model override when not provided', () => {
      expect(buildWorkStreamSpawnAgentBody('engineer')).toEqual({ agentTypeId: 'engineer' })
    })

    it('applies a global model override to spawned agents', () => {
      expect(buildWorkStreamSpawnAgentBody('engineer', 'anthropic:claude-sonnet-4-5:high')).toEqual({
        agentTypeId: 'engineer',
        model: 'anthropic:claude-sonnet-4-5:high',
      })
    })

    it('applies per-agent override only to matching agent type', () => {
      const overrides = parseAgentModelOverrides(['architect=anthropic:claude-sonnet-4-5:high'])

      expect(buildWorkStreamSpawnAgentBody('architect', undefined, overrides)).toEqual({
        agentTypeId: 'architect',
        model: 'anthropic:claude-sonnet-4-5:high',
      })
      expect(buildWorkStreamSpawnAgentBody('engineer', undefined, overrides)).toEqual({ agentTypeId: 'engineer' })
    })

    it('uses per-agent override before global model override', () => {
      const overrides = parseAgentModelOverrides(['architect=anthropic:claude-sonnet-4-5:high'])

      expect(buildWorkStreamSpawnAgentBody('architect', 'anthropic:claude-sonnet-4-5:low', overrides)).toEqual({
        agentTypeId: 'architect',
        model: 'anthropic:claude-sonnet-4-5:high',
      })
      expect(buildWorkStreamSpawnAgentBody('engineer', 'anthropic:claude-sonnet-4-5:low', overrides)).toEqual({
        agentTypeId: 'engineer',
        model: 'anthropic:claude-sonnet-4-5:low',
      })
    })
  })

  describe('parseAgentModelOverrides', () => {
    it('rejects invalid per-agent option format with a clear error', () => {
      expect(() => parseAgentModelOverrides(['architect'])).toThrow('Expected format')
      expect(() => parseAgentModelOverrides(['=anthropic:claude-sonnet-4-5'])).toThrow('Expected format')
      expect(() => parseAgentModelOverrides(['architect='])).toThrow('Expected format')
    })

    it('accepts a comma-separated model priority list as the value', () => {
      const overrides = parseAgentModelOverrides(['architect=zai:glm-5.2:high,anthropic:claude-sonnet-4-6'])
      expect(overrides.get('architect')).toBe('zai:glm-5.2:high,anthropic:claude-sonnet-4-6')
    })
  })

  describe('formatWorkStreamAgents', () => {
    it('returns any when the work stream has no bound agents', () => {
      expect(formatWorkStreamAgents(null)).toBe('(any)')
      expect(formatWorkStreamAgents([])).toBe('(any)')
    })

    it('includes each bound agent id prefix, type, name, and status when available', () => {
      const agentId = '11111111-1111-1111-1111-111111111111'
      const summaries = new Map([
        [
          agentId,
          {
            id: agentId,
            agentTypeId: 'engineer',
            metadata: { name: 'Moss' },
            status: 'active',
          },
        ],
      ])

      expect(formatWorkStreamAgents([agentId], summaries)).toBe('11111111 (engineer, Moss, active)')
    })

    it('marks missing or deleted agents as unknown without dropping the binding', () => {
      const agentId = '22222222-2222-2222-2222-222222222222'
      const summaries = new Map([[agentId, null]])

      expect(formatWorkStreamAgents([agentId], summaries)).toBe('22222222 (unknown)')
    })

    it('preserves the work stream agent order', () => {
      const engineerId = '33333333-3333-3333-3333-333333333333'
      const reviewerId = '44444444-4444-4444-4444-444444444444'
      const summaries = new Map([
        [engineerId, { id: engineerId, agentTypeId: 'engineer', metadata: null, status: 'idle' }],
        [reviewerId, { id: reviewerId, agentTypeId: 'reviewer', metadata: null, status: 'idle' }],
      ])

      expect(formatWorkStreamAgents([engineerId, reviewerId], summaries)).toBe(
        '33333333 (engineer, idle), 44444444 (reviewer, idle)'
      )
    })
  })

  describe('metadata commands', () => {
    it('sets and unsets exact nested deltas without a GET', async () => {
      ;(apiPatch as ReturnType<typeof mock>).mockResolvedValue({ id: 'stream-1' })

      await run(['workstream', 'set-meta', 'stream-1', 'ledger.current.sequence', '7'])
      expect(apiGet).not.toHaveBeenCalled()
      expect(apiPatch).toHaveBeenLastCalledWith('/api/workstreams/stream-1', {
        metadata: { ledger: { current: { sequence: 7 } } },
      })

      await run(['workstream', 'unset-meta', 'stream-1', 'ledger.current.sequence'])
      expect(apiGet).not.toHaveBeenCalled()
      expect(apiPatch).toHaveBeenLastCalledWith('/api/workstreams/stream-1', {
        metadata: { ledger: { current: { sequence: null } } },
      })
    })

    it('preserves concurrent unrelated writes with an observable request barrier', async () => {
      const arrived = Promise.withResolvers<void>()
      const requests: Record<string, unknown>[] = []
      let serverState: Record<string, unknown> = {
        ledger: { left: 0, right: 0, neighbor: 'keep' },
        obsolete: 'remove',
        labels: ['old'],
        outside: 'keep',
      }
      const merge = (target: Record<string, unknown>, delta: Record<string, unknown>): Record<string, unknown> => {
        const result = { ...target }
        for (const [key, value] of Object.entries(delta)) {
          if (value === null) delete result[key]
          else if (
            typeof value === 'object' &&
            value !== null &&
            !Array.isArray(value) &&
            typeof result[key] === 'object' &&
            result[key] !== null &&
            !Array.isArray(result[key])
          ) {
            result[key] = merge(result[key] as Record<string, unknown>, value as Record<string, unknown>)
          } else result[key] = value
        }
        return result
      }
      ;(apiPatch as ReturnType<typeof mock>).mockImplementation(
        async (_path: string, body: Record<string, unknown>) => {
          requests.push(body)
          if (requests.length === 2) {
            serverState = merge(serverState, { obsolete: null, labels: ['external'] })
            arrived.resolve()
          }
          await arrived.promise
          serverState = merge(serverState, body.metadata as Record<string, unknown>)
          return { id: 'stream-1', metadata: serverState }
        }
      )

      await Promise.all([
        run(['workstream', 'set-meta', 'stream-1', 'ledger.left', '1']),
        run(['workstream', 'set-meta', 'stream-1', 'ledger.right', '2']),
      ])

      expect(apiGet).not.toHaveBeenCalled()
      expect(requests).toEqual([{ metadata: { ledger: { left: 1 } } }, { metadata: { ledger: { right: 2 } } }])
      expect(serverState).toEqual({
        ledger: { left: 1, right: 2, neighbor: 'keep' },
        labels: ['external'],
        outside: 'keep',
      })
    })

    it('gets only the selected metadata value', async () => {
      ;(apiGet as ReturnType<typeof mock>).mockResolvedValue({
        id: 'stream-1',
        metadata: { ledger: { current: { labels: ['a', 'b'] } }, outside: 'excluded' },
      })

      await run(['workstream', 'get-meta', 'stream-1', 'ledger.current.labels'])

      expect(apiGet).toHaveBeenCalledTimes(1)
      expect(apiGet).toHaveBeenCalledWith('/api/workstreams/stream-1')
      expect(apiPatch).not.toHaveBeenCalled()
      expect(output).toHaveBeenCalledWith('[\n  "a",\n  "b"\n]')
    })

    it('outputs each raw JSON value with exactly one GET and no PATCH', async () => {
      ;(isJsonMode as ReturnType<typeof mock>).mockReturnValue(true)
      const values: unknown[] = ['text', 7, false, { enabled: true }, ['a', 'b'], null]

      for (const value of values) {
        ;(apiGet as ReturnType<typeof mock>).mockClear()
        ;(apiPatch as ReturnType<typeof mock>).mockClear()
        ;(output as ReturnType<typeof mock>).mockClear()
        ;(apiGet as ReturnType<typeof mock>).mockResolvedValue({ id: 'stream-1', metadata: { selected: value } })

        await run(['workstream', 'get-meta', 'stream-1', 'selected'])

        expect(apiGet).toHaveBeenCalledTimes(1)
        expect(apiGet).toHaveBeenCalledWith('/api/workstreams/stream-1')
        expect(apiPatch).not.toHaveBeenCalled()
        expect(output).toHaveBeenCalledWith(value)
      }
    })

    it('rejects missing or malformed metadata paths', async () => {
      ;(isJsonMode as ReturnType<typeof mock>).mockReturnValue(true)
      ;(apiGet as ReturnType<typeof mock>).mockResolvedValue({ id: 'stream-1', metadata: {} })

      await run(['workstream', 'get-meta', 'stream-1', 'missing'])
      expect(outputError).toHaveBeenLastCalledWith(new Error('Metadata path "missing" not found'))
      ;(apiGet as ReturnType<typeof mock>).mockClear()
      await run(['workstream', 'get-meta', 'stream-1', 'bad..path'])
      expect(apiGet).not.toHaveBeenCalled()
      expect(outputError).toHaveBeenLastCalledWith(
        new Error('Invalid metadata path "bad..path": path segments cannot be empty')
      )
    })
  })
})
