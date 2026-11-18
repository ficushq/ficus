import * as yaml from 'js-yaml'
import { publicVoiceProfileInputSchema, type PublicVoiceSurfaces } from '@ficus/shared'
import { publicVoices } from '../../db'
import { PublicVoice } from '../../entities/PublicVoice'
import { PUBLIC_VOICES_DIR } from '../../lib/paths'
import { ConfigSync } from './ConfigSync'

export interface PublicVoiceYaml {
  id: string
  name: string
  description?: string | null
  base: string
  surfaces: PublicVoiceSurfaces
}

/**
 * Syncs voice profiles from config/public-voices/*.yaml. The shipped profile
 * `default` is the instance default voice; admins edit it as field overrides
 * and can revert it. See docs/wiki/public-voice.md.
 */
export class PublicVoiceSync extends ConfigSync<PublicVoiceYaml> {
  readonly name = 'public-voices'
  readonly directory = PUBLIC_VOICES_DIR
  readonly table = publicVoices
  readonly idColumn = publicVoices.id
  readonly yamlTemplateColumn = publicVoices.yamlTemplate
  readonly yamlFieldOverridesColumn = publicVoices.yamlFieldOverrides
  readonly updatedAtColumn = publicVoices.updatedAt
  readonly disabledColumn = publicVoices.disabled

  parse(content: string, filename: string): PublicVoiceYaml {
    const result = publicVoiceProfileInputSchema.safeParse(yaml.load(content))
    if (!result.success) {
      throw new Error(
        `PublicVoice ${filename}: ${result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`
      )
    }
    const value = result.data
    return {
      id: value.id,
      name: value.name,
      description: value.description ?? null,
      base: value.base,
      surfaces: value.surfaces ?? {},
    }
  }

  getId(value: PublicVoiceYaml): string {
    return value.id
  }

  toRecord(value: PublicVoiceYaml): Record<string, unknown> {
    return {
      id: value.id,
      name: value.name,
      description: value.description ?? null,
      base: value.base,
      surfaces: value.surfaces,
    }
  }

  toComparable(row: Record<string, unknown>): Record<string, unknown> {
    return {
      id: row.id,
      name: row.name,
      description: row.description ?? null,
      base: row.base,
      surfaces: row.surfaces ?? {},
    }
  }

  toYaml(row: Record<string, unknown>): string {
    return yaml.dump(this.toComparable(row), { lineWidth: 120, noRefs: true })
  }

  async afterSync(): Promise<void> {
    PublicVoice.invalidateCache()
  }
}
