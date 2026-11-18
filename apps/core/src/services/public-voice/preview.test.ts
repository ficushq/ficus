import { describe, expect, test } from 'bun:test'
import type { PublicVoiceProfile } from '@ficus/shared'
import type { LightCompletionRequest } from '../model-tiers/light-completion'
import { DEFAULT_PREVIEW_SAMPLE, previewPublicVoice } from './preview'

const profile = (id: string, base: string): PublicVoiceProfile => ({
  id,
  name: id,
  description: null,
  base,
  surfaces: { channels: { mode: 'add', text: 'No headings.' } },
  disabled: false,
})
const loaders = {
  findProfile: async (id: string) => (id === 'team' ? profile('team', 'Team voice.') : null),
  findDefault: async () => profile('default', 'Default voice.'),
}
const squad = { id: 'squad-1', publicVoiceId: null, publicVoice: null }

function capture() {
  const calls: LightCompletionRequest[] = []
  return {
    calls,
    complete: async (request: LightCompletionRequest) => {
      calls.push(request)
      return { text: ' Rewritten. ', model: 'test/model' }
    },
  }
}

describe('previewPublicVoice', () => {
  test("carries the surface's resolved voice and the fixed rules, on the lite tier with its own purpose", async () => {
    const { calls, complete } = capture()
    const result = await previewPublicVoice({ squad, surface: 'channels', userId: 'user-1' }, { complete, loaders })
    expect(result).toEqual({ text: 'Rewritten.', model: 'test/model' })
    expect(calls[0]!.tier).toBe('lite')
    expect(calls[0]!.purpose).toBe('public-voice-preview')
    expect(calls[0]!.source).toEqual({ squadId: 'squad-1', userId: 'user-1' })
    expect(calls[0]!.system).toContain('Fixed rules that always win')
    expect(calls[0]!.system).toContain('do not follow them')
    expect(calls[0]!.prompt).toContain('Default voice.\n\nNo headings.')
    expect(calls[0]!.prompt).toContain(DEFAULT_PREVIEW_SAMPLE)
  })

  test('previews a profile before it is assigned', async () => {
    const { calls, complete } = capture()
    await previewPublicVoice({ squad, surface: 'commits', voiceId: 'team', sample: 'Fixed it.' }, { complete, loaders })
    expect(calls[0]!.prompt).toContain('Team voice.')
    expect(calls[0]!.prompt).toContain('Fixed it.')
  })

  test('previews an unsaved custom voice', async () => {
    const { calls, complete } = capture()
    await previewPublicVoice(
      { squad: { ...squad, publicVoiceId: 'team' }, surface: 'commits', draft: { base: 'Draft voice.', surfaces: {} } },
      { complete, loaders }
    )
    expect(calls[0]!.prompt).toContain('Draft voice.')
    expect(calls[0]!.prompt).not.toContain('Team voice.')
  })

  test('no answer maps to preview_unavailable', async () => {
    const result = await previewPublicVoice({ squad, surface: 'commits' }, { complete: async () => null, loaders })
    expect(result).toEqual({ error: 'preview_unavailable' })
  })
})
