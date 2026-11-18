import { describe, expect, test } from 'bun:test'
import {
  PUBLIC_VOICE_MAX_BYTES,
  derivationFiltersSchema,
  fitPublicVoiceToCap,
  publicVoiceBytes,
  publicVoiceProfileInputSchema,
  renderProfileAlone,
  renderPublicVoicePrompt,
  resolvePublicVoice,
  squadPublicVoicePatchSchema,
  type PublicVoiceProfile,
  type PublicVoiceSurfaces,
} from './public-voice'

const profile = (
  id: string,
  base: string,
  surfaces: PublicVoiceSurfaces = {},
  disabled = false
): PublicVoiceProfile => ({
  id,
  name: id,
  description: null,
  base,
  surfaces,
  disabled,
})
const dflt = profile('default', 'Instance voice.', { channels: { mode: 'add', text: 'No headings.' } })

describe('resolvePublicVoice', () => {
  test('uses the instance default when the squad has nothing', () => {
    const r = resolvePublicVoice({ squad: null, assigned: null, instanceDefault: dflt })
    expect(r.baseSource).toBe('instance')
    expect(r.profileId).toBe('default')
    expect(r.perSurface.commits).toBe('Instance voice.')
    expect(r.perSurface.channels).toBe('Instance voice.\n\nNo headings.')
    expect(r.entrySources.channels).toBe('profile')
  })

  test('an assigned profile replaces the instance default entirely', () => {
    const r = resolvePublicVoice({ squad: null, assigned: profile('team', 'Team voice.'), instanceDefault: dflt })
    expect(r.baseSource).toBe('profile')
    expect(r.profileId).toBe('team')
    expect(r.perSurface.channels).toBe('Team voice.')
  })

  test('a disabled assigned profile falls back to the instance default', () => {
    const r = resolvePublicVoice({ squad: null, assigned: profile('team', 'Team.', {}, true), instanceDefault: dflt })
    expect(r.baseSource).toBe('instance')
    expect(r.profileId).toBe('default')
  })

  test('a squad entry shadows the profile entry for that surface only', () => {
    const r = resolvePublicVoice({
      squad: { base: null, surfaces: { channels: { mode: 'override', text: 'One line.' } } },
      assigned: null,
      instanceDefault: dflt,
    })
    expect(r.perSurface.channels).toBe('One line.')
    expect(r.entrySources.channels).toBe('squad')
    expect(r.perSurface.commits).toBe('Instance voice.')
  })

  test('a custom base makes the squad its own layer and ignores every profile', () => {
    const r = resolvePublicVoice({
      squad: { base: 'Ours.', surfaces: {} },
      assigned: profile('team', 'Team.', { commits: { mode: 'add', text: 'x' } }),
      instanceDefault: dflt,
    })
    expect(r.baseSource).toBe('squad')
    expect(r.profileId).toBeNull()
    expect(r.perSurface.commits).toBe('Ours.')
    expect(r.perSurface.channels).toBe('Ours.')
  })

  test('nothing anywhere resolves to none', () => {
    const r = resolvePublicVoice({ squad: null, assigned: null, instanceDefault: null })
    expect(r.baseSource).toBe('none')
    expect(r.base).toBe('')
  })

  test('a disabled instance default with no assignment resolves to none', () => {
    const r = resolvePublicVoice({ squad: null, assigned: null, instanceDefault: { ...dflt, disabled: true } })
    expect(r.baseSource).toBe('none')
  })
})

describe('renderPublicVoicePrompt', () => {
  test('renders the base once, then only surfaces with an effective entry, in fixed order, overrides marked', () => {
    const r = resolvePublicVoice({
      squad: { base: null, surfaces: { commits: { mode: 'override', text: 'Subject.' } } },
      assigned: null,
      instanceDefault: dflt,
    })
    expect(renderPublicVoicePrompt(r)).toBe(
      '### Voice\n\nInstance voice.\n\n- Commits (instead of the voice above): Subject.\n- Channel messages: No headings.'
    )
  })

  test('entries render without the override marker when there is no base', () => {
    const r = resolvePublicVoice({
      squad: { base: null, surfaces: { commits: { mode: 'override', text: 'Subject.' } } },
      assigned: null,
      instanceDefault: null,
    })
    expect(renderPublicVoicePrompt(r)).toBe('### Voice\n\n- Commits: Subject.')
  })

  test('empty everywhere renders nothing', () => {
    expect(renderPublicVoicePrompt(resolvePublicVoice({ squad: null, assigned: null, instanceDefault: null }))).toBe('')
  })

  test('renderProfileAlone renders a profile by itself, even when disabled', () => {
    expect(renderProfileAlone({ ...dflt, disabled: true })).toBe(
      '### Voice\n\nInstance voice.\n\n- Channel messages: No headings.'
    )
  })
})

describe('cap', () => {
  test('counts UTF-8 bytes', () => {
    expect(publicVoiceBytes('é')).toBe(2)
    expect(publicVoiceBytes('abc')).toBe(3)
  })

  test('fit drops effective entries from the end until it fits and reports them', () => {
    const big = profile('big', 'x'.repeat(PUBLIC_VOICE_MAX_BYTES - 120), {
      commits: { mode: 'add', text: 'y'.repeat(80) },
      channels: { mode: 'add', text: 'z'.repeat(80) },
    })
    const fitted = fitPublicVoiceToCap(
      resolvePublicVoice({ squad: null, assigned: big, instanceDefault: null }),
      PUBLIC_VOICE_MAX_BYTES
    )
    expect(fitted.dropped).toEqual(['channels'])
    expect(fitted.resolved.entries.commits).toBeDefined()
    expect(fitted.resolved.perSurface.channels).toBe(fitted.resolved.base)
    expect(publicVoiceBytes(renderPublicVoicePrompt(fitted.resolved))).toBeLessThanOrEqual(PUBLIC_VOICE_MAX_BYTES)
  })

  test('fit leaves a voice under the cap alone', () => {
    const fitted = fitPublicVoiceToCap(
      resolvePublicVoice({ squad: null, assigned: null, instanceDefault: dflt }),
      PUBLIC_VOICE_MAX_BYTES
    )
    expect(fitted.dropped).toEqual([])
  })
})

describe('schemas', () => {
  test('patch rejects an unknown surface, an empty text, and a base together with a voiceId', () => {
    expect(squadPublicVoicePatchSchema.safeParse({ surfaces: { tweets: { mode: 'add', text: 'x' } } }).success).toBe(
      false
    )
    expect(squadPublicVoicePatchSchema.safeParse({ surfaces: { commits: { mode: 'add', text: '  ' } } }).success).toBe(
      false
    )
    expect(squadPublicVoicePatchSchema.safeParse({ base: 'x', voiceId: 'team' }).success).toBe(false)
    expect(
      squadPublicVoicePatchSchema.safeParse({ base: null, voiceId: 'team', surfaces: { commits: null } }).success
    ).toBe(true)
  })

  test('profile input requires a kebab-case id', () => {
    expect(publicVoiceProfileInputSchema.safeParse({ id: 'Team Voice', name: 'Team', base: 'x' }).success).toBe(false)
    expect(publicVoiceProfileInputSchema.safeParse({ id: 'team-voice', name: 'Team', base: 'x' }).success).toBe(true)
  })

  test('filters accept ISO dates and owner/name repositories only', () => {
    expect(derivationFiltersSchema.safeParse({ before: '2026-03-01', repositories: ['acme/api'] }).success).toBe(true)
    expect(derivationFiltersSchema.safeParse({ before: 'yesterday' }).success).toBe(false)
    expect(derivationFiltersSchema.safeParse({ excludeRepositories: ['not a repo'] }).success).toBe(false)
    expect(derivationFiltersSchema.safeParse({ surfaces: ['tweets'] }).success).toBe(false)
  })
})
