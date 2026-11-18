import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { PublicVoiceProfile, SquadPublicVoiceState } from '@ficus/shared'
import { queryKeys } from '../../queryKeys'
import { buildVoicePatch, draftBytes, pickerValueFor, SquadVoiceEditor } from './SquadVoiceSettings'

const dflt: PublicVoiceProfile = {
  id: 'default',
  name: 'Default',
  description: null,
  base: 'Lead with the result.',
  surfaces: { channels: { mode: 'add', text: 'Shorter, no headings.' } },
  disabled: false,
}

function state(over: Partial<SquadPublicVoiceState> = {}): SquadPublicVoiceState {
  return {
    voiceId: null,
    local: { base: null, surfaces: {} },
    profile: dflt,
    fallback: null,
    availableVoices: [
      { id: 'default', name: 'Default', description: null },
      { id: 'platform', name: 'Platform team', description: 'Terse and technical.' },
    ],
    resolved: {
      base: dflt.base,
      baseSource: 'instance',
      profileId: 'default',
      entries: dflt.surfaces,
      entrySources: { channels: 'profile' },
      perSurface: {} as never,
      rendered: '### Voice\n\nLead with the result.\n\n- Channel messages: Shorter, no headings.',
      bytes: 80,
      maxBytes: 2000,
      overCap: false,
      dropped: [],
    },
    linkedGitHubLogin: 'octocat',
    ...over,
  }
}

function render(squadId: string, permissions: string[], s = state()): string {
  const queryClient = new QueryClient()
  queryClient.setQueryData(queryKeys.auth.permissions(squadId), {
    permissions,
    identity: { type: 'user', userId: 'user-1' },
  })
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <SquadVoiceEditor squadId={squadId} state={s} />
    </QueryClientProvider>
  )
}

describe('SquadVoiceEditor', () => {
  test('editors get the picker, inherited surface rows greyed, the meter and the derive card', () => {
    const html = render('sq-edit', ['squads:read', 'squads:update'])
    expect(html).toContain('Instance default')
    expect(html).toContain('Platform team')
    expect(html).toContain('Custom for this squad')
    expect(html).toContain('data-inherited="true"')
    expect(html).toContain('Shorter, no headings.')
    expect(html).toMatch(/\d+ \/ 2,000 bytes/)
    expect(html).toContain('Derive a voice from GitHub')
    expect(html).toContain('value="octocat"')
    expect(html).toContain('Only before')
  })

  test('a squad entry that replaces the voice shows the Replace option selected', () => {
    const html = render(
      'sq-override',
      ['squads:update'],
      state({ local: { base: null, surfaces: { commits: { mode: 'override', text: 'Subject only.' } } } })
    )
    expect(html).toMatch(/<option value="override" selected="">Replace the voice<\/option>/)
    expect(html).toContain('Subject only.')
  })

  test('without squads:update the resolved voice is shown read-only', () => {
    const html = render('sq-read', ['squads:read'])
    expect(html).not.toContain('Custom for this squad')
    expect(html).not.toContain('Derive a voice from GitHub')
    expect(html).toContain('Lead with the result.')
  })

  test('reports a disabled assigned profile and an over-cap voice', () => {
    const html = render(
      'sq-warn',
      ['squads:update'],
      state({
        voiceId: 'platform',
        fallback: 'assigned_disabled',
        resolved: { ...state().resolved, overCap: true, dropped: ['channels'] },
      })
    )
    expect(html).toContain('is disabled')
    expect(html).toContain('Channel messages')
  })
})

describe('voice editing helpers', () => {
  test('the picker reflects a custom base, an assignment or the instance default', () => {
    expect(pickerValueFor({ voiceId: null, local: { base: 'x', surfaces: {} } })).toBe('__custom__')
    expect(pickerValueFor({ voiceId: 'platform', local: { base: null, surfaces: {} } })).toBe('platform')
    expect(pickerValueFor({ voiceId: null, local: { base: null, surfaces: {} } })).toBe('__instance__')
  })

  test('the meter uses the shared renderer, and is unknown for an unloaded profile', () => {
    const s = state()
    expect(draftBytes(s, '__instance__', '', {})).toBe(new TextEncoder().encode(s.resolved.rendered).length)
    expect(draftBytes(s, '__custom__', 'Ours.', {})).toBe('### Voice\n\nOurs.'.length)
    expect(draftBytes(s, 'platform', '', {})).toBeNull()
  })

  test('the patch sets exactly one base source and every surface', () => {
    expect(buildVoicePatch('__custom__', ' Ours. ', {})).toEqual({
      base: 'Ours.',
      surfaces: { commits: null, pullRequests: null, reviewReplies: null, issueComments: null, channels: null },
    })
    const patch = buildVoicePatch('platform', '', { commits: { mode: 'add', text: 'x' } })
    expect(patch.voiceId).toBe('platform')
    expect(patch.base).toBeNull()
    expect(patch.surfaces?.commits).toEqual({ mode: 'add', text: 'x' })
    expect(buildVoicePatch('__instance__', '', {}).voiceId).toBeNull()
  })
})
