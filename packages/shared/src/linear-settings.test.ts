import { describe, expect, test } from 'bun:test'
import { effectiveLinearSettings, squadLinearSettingsSchema } from './linear-settings'
import { squadMetadataSchema } from './schemas'

describe('Linear squad settings', () => {
  test('defaults to closes for the origin issue and links for other tracked issues', () => {
    expect(effectiveLinearSettings(undefined).pullRequestLinks).toEqual({ origin: 'closes', tracked: 'links' })
    expect(effectiveLinearSettings({}).pullRequestLinks).toEqual({ origin: 'closes', tracked: 'links' })
    expect(effectiveLinearSettings({ integrationSettings: { linear: { version: 1 } } }).pullRequestLinks).toEqual({
      origin: 'closes',
      tracked: 'links',
    })
  })

  test('fills only the missing field', () => {
    const metadata = { integrationSettings: { linear: { version: 1, pullRequestLinks: { tracked: 'contributes' } } } }
    expect(effectiveLinearSettings(metadata).pullRequestLinks).toEqual({ origin: 'closes', tracked: 'contributes' })
  })

  test('falls back to the defaults for a stored value that no longer parses', () => {
    const metadata = { integrationSettings: { linear: { version: 2, pullRequestLinks: { origin: 'links' } } } }
    expect(effectiveLinearSettings(metadata).pullRequestLinks).toEqual({ origin: 'closes', tracked: 'links' })
  })

  test('the schema accepts only Linear link kinds and known keys', () => {
    expect(squadLinearSettingsSchema.safeParse({ version: 1, pullRequestLinks: { origin: 'links' } }).success).toBe(
      true
    )
    expect(squadLinearSettingsSchema.safeParse({ version: 1, pullRequestLinks: { origin: 'fixes' } }).success).toBe(
      false
    )
    expect(squadLinearSettingsSchema.safeParse({ version: 1, extra: true }).success).toBe(false)
  })

  test('squad metadata writes are validated with a path-qualified error', () => {
    const valid = squadMetadataSchema.safeParse({
      integrationSettings: { linear: { version: 1, pullRequestLinks: { origin: 'contributes', tracked: 'closes' } } },
    })
    expect(valid.success).toBe(true)
    const invalid = squadMetadataSchema.safeParse({
      integrationSettings: { linear: { version: 1, pullRequestLinks: { origin: 'resolves' } } },
    })
    expect(invalid.success).toBe(false)
    expect(invalid.error?.issues[0]?.path).toEqual(['integrationSettings', 'linear', 'pullRequestLinks', 'origin'])
  })
})
