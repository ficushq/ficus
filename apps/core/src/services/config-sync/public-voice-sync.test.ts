import { afterAll, describe, expect, test } from 'bun:test'
import { eq, inArray } from 'drizzle-orm'
import { db, publicVoices, squads } from '../../db'
import { PublicVoice } from '../../entities/PublicVoice'
import { Squad } from '../../entities/Squad'
import { PublicVoiceSync } from './public-voice-sync'

const sync = new PublicVoiceSync()
const PREFIX = `pv-sync-${Date.now()}`
const createdSquadIds: string[] = []

afterAll(async () => {
  if (createdSquadIds.length) await db.delete(squads).where(inArray(squads.id, createdSquadIds))
  await db.delete(publicVoices).where(eq(publicVoices.id, `${PREFIX}-team`))
  await sync.revertToTemplate('default').catch(() => {})
  await PublicVoice.setDisabled('default', false)
})

describe('PublicVoiceSync.parse', () => {
  test('accepts a profile with surfaces', () => {
    const parsed = sync.parse(
      'id: team\nname: Team\nbase: Team voice.\nsurfaces:\n  commits:\n    mode: add\n    text: Short.\n',
      'team.yaml'
    )
    expect(parsed).toEqual({
      id: 'team',
      name: 'Team',
      description: null,
      base: 'Team voice.',
      surfaces: { commits: { mode: 'add', text: 'Short.' } },
    })
  })

  test('rejects a bad id, an unknown surface, or a missing base', () => {
    expect(() => sync.parse('id: Team Voice\nname: Team\nbase: x\n', 'x.yaml')).toThrow()
    expect(() =>
      sync.parse('id: team\nname: Team\nbase: x\nsurfaces:\n  tweets:\n    mode: add\n    text: y\n', 'x.yaml')
    ).toThrow()
    expect(() => sync.parse('id: team\nname: Team\n', 'x.yaml')).toThrow()
  })
})

describe('PublicVoiceSync', () => {
  test('inserts the shipped default with a template and all five surfaces', async () => {
    await sync.sync()
    const profile = (await PublicVoice.findDefault())!
    expect(profile).toBeTruthy()
    expect(profile.base).toContain('Lead with the result or the action')
    expect(Object.keys(profile.surfaces).sort()).toEqual([
      'channels',
      'commits',
      'issueComments',
      'pullRequests',
      'reviewReplies',
    ])
    const json = profile.toJson()
    expect(json.hasTemplate).toBe(true)
    expect(json.yamlFieldOverrides).toEqual([])
    expect(json.bytes).toBeGreaterThan(500)
  })

  test('an admin edit becomes a field override that survives resync; revert restores the template', async () => {
    await sync.sync()
    const original = (await PublicVoice.findDefault())!
    await PublicVoice.upsert({ id: 'default', name: original.name, base: 'Edited voice.', surfaces: original.surfaces })
    await sync.recomputeFieldOverrides('default')
    PublicVoice.invalidateCache()
    expect((await PublicVoice.findDefault())!.toJson().yamlFieldOverrides).toEqual(['base'])

    await sync.sync()
    expect((await PublicVoice.findDefault())!.base).toBe('Edited voice.')

    await sync.revertToTemplate('default')
    PublicVoice.invalidateCache()
    const reverted = (await PublicVoice.findDefault())!
    expect(reverted.base).toBe(original.base)
    expect(reverted.toJson().yamlFieldOverrides).toEqual([])
  })

  test('a surfaces edit is recorded as a surfaces override regardless of key order', async () => {
    await sync.sync()
    const original = (await PublicVoice.findDefault())!
    const reordered = Object.fromEntries(Object.entries(original.surfaces).reverse())
    await PublicVoice.upsert({ id: 'default', name: original.name, base: original.base, surfaces: reordered })
    await sync.recomputeFieldOverrides('default')
    PublicVoice.invalidateCache()
    expect((await PublicVoice.findDefault())!.toJson().yamlFieldOverrides).toEqual([])
  })

  test('squad assignment persists, serializes, and is cleared when the profile is deleted', async () => {
    await PublicVoice.upsert({ id: `${PREFIX}-team`, name: 'Team', base: 'Team voice.' })
    const squad = await Squad.create({ name: `${PREFIX}-squad`, purpose: 'public voice' })
    createdSquadIds.push(squad.id)

    const updated = await Squad.setPublicVoice(squad.id, {
      publicVoiceId: `${PREFIX}-team`,
      publicVoice: { base: null, surfaces: { commits: { mode: 'add', text: 'Short.' } } },
    })
    expect(updated.toJson().publicVoiceId).toBe(`${PREFIX}-team`)
    expect(updated.toJson().publicVoice?.surfaces.commits?.text).toBe('Short.')
    expect((await PublicVoice.assignedSquadCounts([`${PREFIX}-team`])).get(`${PREFIX}-team`)).toBe(1)

    await PublicVoice.delete(`${PREFIX}-team`)
    const reloaded = (await Squad.find(squad.id))!
    expect(reloaded.publicVoiceId).toBeNull()
    expect(reloaded.publicVoice?.surfaces.commits?.text).toBe('Short.')
  })
})
