import type { PublicVoiceProfileJson, PublicVoiceSurfaces } from '@ficus/shared'
import { publicVoiceBytes, renderProfileAlone } from '@ficus/shared'

export interface ProfileDraft {
  name: string
  description: string
  base: string
  surfaces: PublicVoiceSurfaces
}

export function draftOf(
  profile: Pick<PublicVoiceProfileJson, 'name' | 'description' | 'base' | 'surfaces'>
): ProfileDraft {
  return { name: profile.name, description: profile.description ?? '', base: profile.base, surfaces: profile.surfaces }
}

export function draftBytes(id: string, draft: ProfileDraft): number {
  return publicVoiceBytes(
    renderProfileAlone({
      id,
      name: draft.name,
      description: null,
      base: draft.base,
      surfaces: draft.surfaces,
      disabled: false,
    })
  )
}
