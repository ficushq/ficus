import { describe, expect, test } from 'bun:test'
import type { PublicVoiceProfile } from '@ficus/shared'
import {
  PUBLIC_VOICE_PROMPT_TOKEN,
  buildPublicVoicePrompt,
  publicVoicePromptFallback,
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

function loaders(profiles: PublicVoiceProfile[]): PublicVoiceLoaders {
  const byId = new Map(profiles.map((p) => [p.id, p]))
  return {
    findProfile: async (id) => byId.get(id) ?? null,
    findDefault: async () => byId.get('default') ?? null,
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
