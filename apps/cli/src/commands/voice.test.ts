import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { Command } from 'commander'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { apiDelete, apiGet, apiPatch, apiPost, apiPut } from '../client'
import { ApiRequestError } from '../client-errors'
import { isJsonMode, output, outputError, setOutputOptions } from '../output'
import { registerSquadCommands } from './squad'
import { registerVoiceCommands } from './voice'

const m = (fn: unknown) => fn as ReturnType<typeof mock>

let dir: string
beforeEach(() => {
  for (const fn of [apiGet, apiPost, apiPut, apiPatch, apiDelete, output, outputError]) m(fn).mockClear()
  m(apiGet).mockResolvedValue({})
  m(apiPost).mockResolvedValue({})
  m(apiPatch).mockResolvedValue({})
  dir = mkdtempSync(join(tmpdir(), 'voice-cli-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

async function run(args: string[]): Promise<void> {
  const program = new Command()
  program.exitOverride()
  program.option('--json')
  program.option('--quiet')
  program.hook('preAction', (command) => setOutputOptions(command.optsWithGlobals()))
  registerVoiceCommands(program)
  registerSquadCommands(program)
  await program.parseAsync(['--quiet', ...args], { from: 'user' })
}

const lastError = () => (m(outputError).mock.calls.at(-1)?.[0] as Error | undefined)?.message

describe('ficus voice', () => {
  it('lists and shows profiles', async () => {
    m(apiGet).mockResolvedValue([])
    await run(['voice', 'list'])
    expect(apiGet).toHaveBeenCalledWith('/api/public-voices')
    await run(['voice', 'show', 'team'])
    expect(apiGet).toHaveBeenLastCalledWith('/api/public-voices/team')
  })

  it('creates a profile with surface entries', async () => {
    await run([
      'voice',
      'create',
      'team',
      '--name',
      'Team',
      '--text',
      'Team voice.',
      '--add',
      'channels=Short.',
      '--override',
      'pull-requests=Long form.',
    ])
    expect(apiPost).toHaveBeenCalledWith('/api/public-voices', {
      id: 'team',
      name: 'Team',
      base: 'Team voice.',
      surfaces: { channels: { mode: 'add', text: 'Short.' }, pullRequests: { mode: 'override', text: 'Long form.' } },
    })
  })

  it('creates a profile from a derived draft file', async () => {
    const path = join(dir, 'draft.json')
    writeFileSync(
      path,
      JSON.stringify({ draft: { base: 'Derived.', surfaces: { commits: { mode: 'add', text: 'Imperative.' } } } })
    )
    await run(['voice', 'create', 'mine', '--name', 'Mine', '--from-draft', path])
    expect(apiPost).toHaveBeenCalledWith('/api/public-voices', {
      id: 'mine',
      name: 'Mine',
      base: 'Derived.',
      surfaces: { commits: { mode: 'add', text: 'Imperative.' } },
    })
  })

  it('refuses an unknown surface and text given twice', async () => {
    await run(['voice', 'create', 'team', '--name', 'T', '--text', 'x', '--add', 'tweets=y'])
    expect(lastError()).toContain('Unknown surface "tweets"')
    await run(['voice', 'create', 'team', '--name', 'T', '--text', 'x', '--file', join(dir, 'nope')])
    expect(lastError()).toContain('not both')
    expect(apiPost).not.toHaveBeenCalled()
  })

  it('updates keeping unspecified fields, and manages the lifecycle', async () => {
    m(apiGet).mockResolvedValue({
      id: 'team',
      name: 'Team',
      base: 'Old.',
      surfaces: { commits: { mode: 'add', text: 'c' } },
    })
    await run(['voice', 'update', 'team', '--text', 'New.'])
    expect(apiPut).toHaveBeenCalledWith('/api/public-voices/team', {
      name: 'Team',
      base: 'New.',
      surfaces: { commits: { mode: 'add', text: 'c' } },
    })
    await run(['voice', 'disable', 'team'])
    expect(apiPost).toHaveBeenLastCalledWith('/api/public-voices/team/disable', {})
    await run(['voice', 'enable', 'team'])
    expect(apiPost).toHaveBeenLastCalledWith('/api/public-voices/team/enable', {})
    await run(['voice', 'revert', 'default'])
    expect(apiPost).toHaveBeenLastCalledWith('/api/public-voices/default/revert-to-template', {})
    await run(['voice', 'delete', 'team'])
    expect(apiDelete).toHaveBeenCalledWith('/api/public-voices/team')
  })

  it('update merges surface entries over the stored ones and can remove one', async () => {
    m(apiGet).mockResolvedValue({
      id: 'default',
      name: 'Default',
      base: 'Base.',
      surfaces: {
        commits: { mode: 'add', text: 'c' },
        channels: { mode: 'add', text: 'short' },
        reviewReplies: { mode: 'add', text: 'one per thread' },
      },
    })
    await run(['voice', 'update', 'default', '--override', 'channels=One line.', '--remove-surface', 'review-replies'])
    expect(apiPut).toHaveBeenLastCalledWith('/api/public-voices/default', {
      name: 'Default',
      base: 'Base.',
      surfaces: { commits: { mode: 'add', text: 'c' }, channels: { mode: 'override', text: 'One line.' } },
    })
    await run(['voice', 'update', 'default', '--add', 'channels=x', '--remove-surface', 'channels'])
    expect(lastError()).toContain('both set and removed')
  })

  it('derives through a squad with filters and writes the draft', async () => {
    const result = {
      login: 'octocat',
      draft: { base: 'Draft.', surfaces: {} },
      observations: [],
      exemplars: [],
      sampling: {
        filters: {},
        counts: {
          collected: 1,
          kept: 1,
          droppedByFilter: { date: 0, repository: 0 },
          droppedAsToolAuthored: 0,
          droppedAsTemplate: 0,
        },
        dateRange: {},
        publicRepositories: [],
        privateRepositories: [],
        pagingCapped: false,
      },
      bytes: 20,
      maxBytes: 2000,
    }
    m(apiPost).mockResolvedValue(result)
    const out = join(dir, 'out.json')
    const log = console.log
    console.log = () => {}
    try {
      await run([
        'voice',
        'derive',
        '--squad',
        's1',
        '--github',
        'octocat',
        '--before',
        '2026-03-01',
        '--repo',
        'acme/api',
        '--out',
        out,
      ])
    } finally {
      console.log = log
    }
    expect(apiPost).toHaveBeenCalledWith('/api/squads/s1/voice/derive', {
      login: 'octocat',
      filters: { before: '2026-03-01', repositories: ['acme/api'] },
    })
    expect(JSON.parse(readFileSync(out, 'utf8')).draft.base).toBe('Draft.')
    expect(apiPost).toHaveBeenCalledTimes(1)
    expect(apiPut).not.toHaveBeenCalled()
    expect(apiPatch).not.toHaveBeenCalled()
    m(apiPost).mockClear()
    m(isJsonMode).mockReturnValue(true)
    await run(['squad', 'voice', 'derive', 's1', '--github', 'someone'])
    expect(output).toHaveBeenLastCalledWith(result)
    expect(apiPost).toHaveBeenCalledTimes(1)
    expect(apiPost).toHaveBeenLastCalledWith('/api/squads/s1/voice/derive', { login: 'someone', filters: {} })
    expect(apiPut).not.toHaveBeenCalled()
    expect(apiPatch).not.toHaveBeenCalled()
  })
})

describe('ficus squad voice', () => {
  const state = {
    voiceId: null,
    local: { base: null, surfaces: {} },
    profile: null,
    fallback: null,
    availableVoices: [],
    resolved: {
      base: 'B.',
      baseSource: 'instance',
      profileId: 'default',
      entries: {},
      entrySources: {},
      perSurface: {},
      rendered: '',
      bytes: 10,
      maxBytes: 2000,
      overCap: false,
      dropped: [],
    },
    linkedGitHubLogin: null,
  }
  const quiet = async (args: string[]) => {
    const log = console.log
    console.log = () => {}
    try {
      await run(args)
    } finally {
      console.log = log
    }
  }
  beforeEach(() => {
    m(apiGet).mockResolvedValue(state)
    m(apiPatch).mockResolvedValue(state)
  })

  it('shows the voice', async () => {
    await quiet(['squad', 'voice', 'show', 's1'])
    expect(apiGet).toHaveBeenCalledWith('/api/squads/s1/voice')
  })

  it('assigns a profile or the instance default', async () => {
    await quiet(['squad', 'voice', 'use', 's1', 'team'])
    expect(apiPatch).toHaveBeenLastCalledWith('/api/squads/s1/voice', { voiceId: 'team' })
    await quiet(['squad', 'voice', 'use', 's1', '--instance-default'])
    expect(apiPatch).toHaveBeenLastCalledWith('/api/squads/s1/voice', { voiceId: null })
  })

  it('sets a custom voice and surface entries', async () => {
    await quiet(['squad', 'voice', 'set', 's1', '--text', 'Ours.'])
    expect(apiPatch).toHaveBeenLastCalledWith('/api/squads/s1/voice', { base: 'Ours.' })
    await quiet(['squad', 'voice', 'set', 's1', '--surface', 'pull-requests', '--add', '--text', 'Short.'])
    expect(apiPatch).toHaveBeenLastCalledWith('/api/squads/s1/voice', {
      surfaces: { pullRequests: { mode: 'add', text: 'Short.' } },
    })
    await quiet(['squad', 'voice', 'set', 's1', '--surface', 'commits', '--text', 'x'])
    expect(lastError()).toContain('exactly one of --add or --override')
  })

  it('clears the custom voice, one surface, or everything', async () => {
    await quiet(['squad', 'voice', 'clear', 's1'])
    expect(apiPatch).toHaveBeenLastCalledWith('/api/squads/s1/voice', { base: null })
    await quiet(['squad', 'voice', 'clear', 's1', '--surface', 'commits'])
    expect(apiPatch).toHaveBeenLastCalledWith('/api/squads/s1/voice', { surfaces: { commits: null } })
    await quiet(['squad', 'voice', 'clear', 's1', '--all'])
    expect(apiDelete).toHaveBeenCalledWith('/api/squads/s1/voice')
  })

  it.each([
    ['derivation_github_unavailable', 422, 'GitHub is unavailable'],
    ['derivation_login_not_visible', 422, 'The GitHub login was not found or is not visible'],
    ['derivation_too_few_samples', 422, 'Too few samples: kept 2 of 10 collected; at least 8 are required.'],
    ['derivation_invalid_output', 422, 'The model returned an invalid voice draft'],
    ['derivation_model_unavailable', 422, 'The derivation model is unavailable'],
  ])('explains %s without exposing the raw payload', async (code, status, sentence) => {
    const payload = { error: code, counts: { kept: 2, collected: 10 }, minimum: 8, reason: 'PRIVATE_FIXTURE' }
    m(apiPost).mockRejectedValue(new ApiRequestError(code, status, code, payload))
    await run(['squad', 'voice', 'derive', 's1', '--github', 'octocat'])
    expect(lastError()).toContain(`${code}: `)
    expect(lastError()).toContain(sentence)
    expect(lastError()).not.toContain('PRIVATE_FIXTURE')
  })

  it('shows a safe validation reason, not arbitrary server text', async () => {
    m(apiPost).mockRejectedValue(
      new ApiRequestError('derivation_invalid_output', 422, 'derivation_invalid_output', {
        reason: 'private_text_in_base',
      })
    )
    await run(['squad', 'voice', 'derive', 's1', '--github', 'octocat'])
    expect(lastError()).toContain('overlapped private sample text')
  })

  it('handles missing or malformed counts without printing untrusted values', async () => {
    for (const payload of [undefined, { counts: { kept: 'injected', collected: -1 }, minimum: 'injected' }]) {
      m(apiPost).mockRejectedValue(
        new ApiRequestError('derivation_too_few_samples', 422, 'derivation_too_few_samples', payload)
      )
      await run(['squad', 'voice', 'derive', 's1', '--github', 'octocat'])
      expect(lastError()).toBe('derivation_too_few_samples: Too few usable samples were found to derive a voice.')
    }
  })

  it.each([
    new ApiRequestError('Unauthorized', 401),
    new ApiRequestError('Permission denied', 403, 'forbidden'),
    new ApiRequestError('Request failed: 502', 502),
    new ApiRequestError('derivation_in_progress', 429, 'derivation_in_progress'),
    new Error('Network disconnected'),
  ])('preserves other failures: %s', async (error) => {
    m(apiPost).mockRejectedValue(error)
    await run(['squad', 'voice', 'derive', 's1', '--github', 'octocat'])
    expect(lastError()).toBe(error.message)
  })

  it('previews and derives', async () => {
    m(apiPost).mockResolvedValue({ text: 'Rewritten.', model: 'm' })
    await quiet(['squad', 'voice', 'preview', 's1', '--surface', 'channels', '--voice', 'team'])
    expect(apiPost).toHaveBeenLastCalledWith('/api/squads/s1/voice/preview', { surface: 'channels', voiceId: 'team' })

    m(apiPost).mockRejectedValue(
      new ApiRequestError('derivation_model_unavailable', 422, 'derivation_model_unavailable')
    )
    await quiet([
      'squad',
      'voice',
      'derive',
      's1',
      '--github',
      'octocat',
      '--include-tool-authored',
      '--surfaces',
      'commits,reviews',
    ])
    expect(apiPost).toHaveBeenLastCalledWith('/api/squads/s1/voice/derive', {
      login: 'octocat',
      filters: { surfaces: ['commits', 'reviews'], excludeToolAuthored: false },
    })
  })
})
