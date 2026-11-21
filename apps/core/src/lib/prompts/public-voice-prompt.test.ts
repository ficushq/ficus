import { describe, expect, test } from 'bun:test'
import type { PublicVoiceProfile } from '@ficus/shared'
import {
  PUBLIC_VOICE_PROMPT_TOKEN,
  buildPublicVoicePrompt,
  describeInstanceDefault,
  publicVoicePromptFallback,
  resolveInstanceDefaultVoice,
  resolveSquadPublicVoice,
  type PublicVoiceLoaders,
} from './public-voice-prompt'

const profile = (id: string, base: string, disabled = false): PublicVoiceProfile => ({
  id,
  name: id,
  description: null,
  base,
  surfaces: {},
  disabled,
})

function loaders(profiles: PublicVoiceProfile[], instanceDefaultId: string | null = null): PublicVoiceLoaders {
  const byId = new Map(profiles.map((p) => [p.id, p]))
  return {
    findProfile: async (id) => byId.get(id) ?? null,
    findDefault: async () => byId.get('default') ?? null,
    findInstanceDefaultId: async () => instanceDefaultId,
  }
}

const squad = (over: Partial<{ publicVoiceId: string | null; publicVoice: any }> = {}) => ({
  id: 'squad-1',
  publicVoiceId: null,
  publicVoice: null,
  ...over,
})

describe('buildPublicVoicePrompt', () => {
  const all = loaders([profile('default', 'Default voice.'), profile('team', 'Team voice.')])

  test("renders the assigned profile's base", async () => {
    expect(await buildPublicVoicePrompt(squad({ publicVoiceId: 'team' }), all)).toBe('### Voice\n\nTeam voice.')
  })

  test('renders a custom base', async () => {
    expect(await buildPublicVoicePrompt(squad({ publicVoice: { base: 'Ours.', surfaces: {} } }), all)).toBe(
      '### Voice\n\nOurs.'
    )
  })

  test('renders the instance default without a squad', async () => {
    expect(await buildPublicVoicePrompt(null, all)).toBe('### Voice\n\nDefault voice.')
  })

  test('renders nothing when the default is disabled and nothing is assigned', async () => {
    expect(await buildPublicVoicePrompt(squad(), loaders([profile('default', 'Default.', true)]))).toBe('')
  })

  test('degrades to an empty section when loading fails', async () => {
    const failing: PublicVoiceLoaders = {
      findProfile: async () => {
        throw new Error('db down')
      },
      findDefault: async () => {
        throw new Error('db down')
      },
    }
    expect(await buildPublicVoicePrompt(squad({ publicVoiceId: 'team' }), failing)).toBe('')
  })
})

describe('resolveSquadPublicVoice', () => {
  test('reports a missing or disabled assignment and falls back to the default', async () => {
    const missing = await resolveSquadPublicVoice(squad({ publicVoiceId: 'gone' }), loaders([profile('default', 'D.')]))
    expect(missing.fallback).toBe('assigned_missing')
    expect(missing.profile?.id).toBe('default')

    const disabled = await resolveSquadPublicVoice(
      squad({ publicVoiceId: 'team' }),
      loaders([profile('default', 'D.'), profile('team', 'T.', true)])
    )
    expect(disabled.fallback).toBe('assigned_disabled')
    expect(disabled.resolved.baseSource).toBe('instance')
  })

  test('an unassigned squad uses the chosen instance default; assignments and custom bases are unchanged', async () => {
    const profiles = [profile('default', 'Shipped.'), profile('team', 'Team.'), profile('mine', 'Mine.')]
    const chosen = loaders(profiles, 'mine')

    const unassigned = await resolveSquadPublicVoice(squad(), chosen)
    expect(unassigned.resolved.base).toBe('Mine.')
    expect(unassigned.resolved.baseSource).toBe('instance')
    expect(unassigned.resolved.profileId).toBe('mine')
    expect(unassigned.profile?.id).toBe('mine')
    expect(unassigned.fallback).toBeNull()
    expect(unassigned.instanceDefault.voiceId).toBe('mine')
    expect(await buildPublicVoicePrompt(null, chosen)).toBe('### Voice\n\nMine.')

    const assigned = await resolveSquadPublicVoice(squad({ publicVoiceId: 'team' }), chosen)
    expect(assigned.resolved.base).toBe('Team.')
    expect(assigned.resolved.baseSource).toBe('profile')
    // An explicit assignment to the shipped profile stays on it.
    const shipped = await resolveSquadPublicVoice(squad({ publicVoiceId: 'default' }), chosen)
    expect(shipped.resolved.base).toBe('Shipped.')
    const custom = await resolveSquadPublicVoice(squad({ publicVoice: { base: 'Ours.', surfaces: {} } }), chosen)
    expect(custom.resolved.base).toBe('Ours.')

    // A disabled assignment falls back to the chosen default, not the shipped one.
    const disabledAssignment = await resolveSquadPublicVoice(
      squad({ publicVoiceId: 'team' }),
      loaders([profile('default', 'Shipped.'), profile('team', 'Team.', true), profile('mine', 'Mine.')], 'mine')
    )
    expect(disabledAssignment.resolved.base).toBe('Mine.')
    expect(disabledAssignment.fallback).toBe('assigned_disabled')
  })

  test('a disabled or missing chosen default falls back to the shipped default and reports it', async () => {
    const disabled = await resolveSquadPublicVoice(
      squad(),
      loaders([profile('default', 'Shipped.'), profile('mine', 'Mine.', true)], 'mine')
    )
    expect(disabled.resolved.base).toBe('Shipped.')
    expect(disabled.resolved.baseSource).toBe('instance')
    expect(disabled.fallback).toBe('default_disabled')
    expect(disabled.profile?.id).toBe('default')
    expect(disabled.instanceDefault).toMatchObject({ voiceId: 'mine', fallback: 'default_disabled' })

    const missing = await resolveSquadPublicVoice(squad(), loaders([profile('default', 'Shipped.')], 'gone'))
    expect(missing.resolved.base).toBe('Shipped.')
    expect(missing.fallback).toBe('default_missing')
    expect(missing.instanceDefault.chosen).toBeNull()

    // A squad with a usable assignment or its own base does not report the default's fallback.
    const assigned = await resolveSquadPublicVoice(
      squad({ publicVoiceId: 'team' }),
      loaders([profile('default', 'Shipped.'), profile('team', 'Team.')], 'gone')
    )
    expect(assigned.fallback).toBeNull()

    // Both unusable: no voice, and the fallback is still reported.
    const none = await resolveSquadPublicVoice(
      squad(),
      loaders([profile('default', 'Shipped.', true), profile('mine', 'Mine.', true)], 'mine')
    )
    expect(none.resolved.baseSource).toBe('none')
    expect(none.fallback).toBe('default_disabled')
  })

  test('describeInstanceDefault names the chosen and the effective profile', async () => {
    const profiles = [profile('default', 'Shipped.'), profile('mine', 'Mine.', true)]
    expect(describeInstanceDefault(await resolveInstanceDefaultVoice(loaders(profiles, 'mine')))).toEqual({
      voiceId: 'mine',
      name: 'mine',
      effectiveVoiceId: 'default',
      effectiveName: 'default',
      fallback: 'default_disabled',
    })
    expect(describeInstanceDefault(await resolveInstanceDefaultVoice(loaders(profiles)))).toEqual({
      voiceId: 'default',
      name: 'default',
      effectiveVoiceId: 'default',
      effectiveName: 'default',
      fallback: null,
    })
    // Loaders without a chosen id (older callers) use the shipped default.
    const legacy: PublicVoiceLoaders = {
      findProfile: async () => null,
      findDefault: async () => profile('default', 'Shipped.'),
    }
    expect((await resolveInstanceDefaultVoice(legacy)).voiceId).toBe('default')
  })

  test('has no effective profile with a custom base', async () => {
    const result = await resolveSquadPublicVoice(
      squad({ publicVoiceId: null, publicVoice: { base: 'Ours.', surfaces: {} } }),
      loaders([profile('default', 'D.')])
    )
    expect(result.profile).toBeNull()
    expect(result.fallback).toBeNull()
  })
})

describe('publicVoicePromptFallback', () => {
  test('appends only when the token is absent and public-text is enabled', () => {
    expect(publicVoicePromptFallback('custom prompt', '### Voice\n\nX.', true)).toBe('### Voice\n\nX.')
    expect(publicVoicePromptFallback(`rules\n${PUBLIC_VOICE_PROMPT_TOKEN}`, '### Voice\n\nX.', true)).toBe('')
    expect(publicVoicePromptFallback('custom prompt', '### Voice\n\nX.', false)).toBe('')
    expect(publicVoicePromptFallback('custom prompt', '', true)).toBe('')
  })
})
