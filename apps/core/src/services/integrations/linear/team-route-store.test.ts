import { afterEach, describe, expect, mock, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import type { LinearTeamDirectory } from '@ficus/shared'
import { eq, inArray } from 'drizzle-orm'
import { db, squads } from '../../../db'
import {
  reconcileSquadLinearTeamRoutes,
  reconcileStoredLinearTeamKeys,
  resolveSquadLinearEventRuleTeams,
  resolveSquadLinearTeamRoutes,
} from './team-route-store'
import { LinearTeamRouteError } from './team-routes'

const FIC = { id: randomUUID(), key: 'FIC', name: 'Ficus', connectionIds: ['c1'] }
const directory: LinearTeamDirectory = {
  teams: [FIC],
  connections: [{ id: 'c1', displayName: 'Linear', isDefault: true, status: 'ok' }],
}
const created: string[] = []

function rule(id: string, teamId?: string) {
  return {
    id,
    enabled: true,
    source: { integration: 'linear', output: 'issue.assigned', version: 1 },
    filters: { squadRouting: false, audience: 'any', ...(teamId === undefined ? {} : { teamId }) },
    action: { type: 'notify-manager' },
  }
}

async function addSquad(metadata: Record<string, unknown>) {
  const [squad] = await db
    .insert(squads)
    .values({ name: `linear-routes-${randomUUID()}`, purpose: 'Linear team routes', metadata })
    .returning()
  created.push(squad!.id)
  return squad!
}

async function storedMetadata(squadId: string) {
  const [row] = await db.select({ metadata: squads.metadata }).from(squads).where(eq(squads.id, squadId))
  return row!.metadata as Record<string, unknown>
}

afterEach(async () => {
  if (created.length) await db.delete(squads).where(inArray(squads.id, created.splice(0)))
})

describe('resolveSquadLinearTeamRoutes', () => {
  test('rejects a new unknown key but keeps one already stored', async () => {
    const squad = await addSquad({ linear: [{ teamId: 'OLD' }] })
    const listTeams = mock(async () => directory)
    await expect(resolveSquadLinearTeamRoutes(squad.id, [{ teamId: 'NEW' }], listTeams)).rejects.toBeInstanceOf(
      LinearTeamRouteError
    )
    expect(await resolveSquadLinearTeamRoutes(squad.id, [{ teamId: 'OLD' }, { teamId: 'fic' }], listTeams)).toEqual([
      { teamId: 'OLD' },
      { teamId: FIC.id },
    ])
    expect(listTeams).toHaveBeenCalledWith(squad.id)
  })
})

describe('resolveSquadLinearEventRuleTeams', () => {
  test('resolves a new key, rejects a new unknown key and keeps a key filter already stored', async () => {
    const squad = await addSquad({ integrationRules: { linear: [rule('old', 'OLD')] } })
    const listTeams = mock(async () => directory)
    await expect(resolveSquadLinearEventRuleTeams(squad.id, [rule('new', 'NEW')], listTeams)).rejects.toBeInstanceOf(
      LinearTeamRouteError
    )
    expect(
      await resolveSquadLinearEventRuleTeams(squad.id, [rule('old', 'OLD'), rule('keyed', 'fic')], listTeams)
    ).toEqual([rule('old', 'OLD'), rule('keyed', FIC.id)])
    expect(listTeams).toHaveBeenCalledWith(squad.id)
  })
})

describe('reconcileSquadLinearTeamRoutes', () => {
  test('rewrites stored event-rule team filter keys and routes with one Linear listing', async () => {
    const squad = await addSquad({
      custom: { kept: true },
      linear: [{ teamId: 'FIC' }],
      integrationRules: { github: [], linear: [rule('keyed', 'FIC'), rule('any'), rule('gone', 'GONE')] },
    })
    const listTeams = mock(async () => directory)
    expect(await reconcileSquadLinearTeamRoutes(squad.id, listTeams)).toBe(true)
    expect(listTeams).toHaveBeenCalledTimes(1)
    expect(await storedMetadata(squad.id)).toEqual({
      custom: { kept: true },
      linear: [{ teamId: FIC.id }],
      integrationRules: { github: [], linear: [rule('keyed', FIC.id), rule('any'), rule('gone', 'GONE')] },
    })
  })

  test('never overwrites event rules saved while Linear was being asked', async () => {
    const squad = await addSquad({ integrationRules: { linear: [rule('keyed', 'FIC')] } })
    const saved = { integrationRules: { linear: [rule('keyed', 'fic')] } }
    const listTeams = async () => {
      await db.update(squads).set({ metadata: saved }).where(eq(squads.id, squad.id))
      return directory
    }
    expect(await reconcileSquadLinearTeamRoutes(squad.id, listTeams)).toBe(false)
    expect(await storedMetadata(squad.id)).toEqual(saved)
  })

  test('rewrites a stored team key to the team ID and keeps other metadata', async () => {
    const squad = await addSquad({ custom: { kept: true }, linear: [{ teamId: 'FIC' }, { teamId: 'GONE' }] })
    expect(await reconcileSquadLinearTeamRoutes(squad.id, async () => directory)).toBe(true)
    expect(await storedMetadata(squad.id)).toEqual({
      custom: { kept: true },
      linear: [{ teamId: FIC.id }, { teamId: 'GONE' }],
    })
    // Nothing left to resolve but the unknown key: no further write.
    expect(await reconcileSquadLinearTeamRoutes(squad.id, async () => directory)).toBe(false)
  })

  test('does not call Linear when every stored route is a team ID', async () => {
    const squad = await addSquad({ linear: [{ teamId: FIC.id }] })
    const listTeams = mock(async () => directory)
    expect(await reconcileSquadLinearTeamRoutes(squad.id, listTeams)).toBe(false)
    expect(listTeams).not.toHaveBeenCalled()
  })

  test('never overwrites routes saved while Linear was being asked', async () => {
    const squad = await addSquad({ linear: [{ teamId: 'FIC' }] })
    const saved = [{ teamId: randomUUID() }]
    const listTeams = async () => {
      await db
        .update(squads)
        .set({ metadata: { linear: saved } })
        .where(eq(squads.id, squad.id))
      return directory
    }
    expect(await reconcileSquadLinearTeamRoutes(squad.id, listTeams)).toBe(false)
    expect(await storedMetadata(squad.id)).toEqual({ linear: saved })
  })
})

describe('reconcileStoredLinearTeamKeys', () => {
  test('rewrites stored keys across squads, asks Linear only for squads with keys and survives a failure', async () => {
    const keyed = await addSquad({ integrationRules: { linear: [rule('keyed', 'FIC')] } })
    const clean = await addSquad({ linear: [{ teamId: FIC.id }], integrationRules: { linear: [rule('any')] } })
    const failing = await addSquad({ linear: [{ teamId: 'FIC' }] })
    const archived = await addSquad({ linear: [{ teamId: 'FIC' }] })
    await db.update(squads).set({ archivedAt: new Date() }).where(eq(squads.id, archived.id))
    const asked: string[] = []
    const errors: string[] = []
    const listTeams = async (squadId: string) => {
      asked.push(squadId)
      if (squadId === failing.id) throw new Error('provider_unavailable')
      return directory
    }
    await reconcileStoredLinearTeamKeys(listTeams, (squadId) => errors.push(squadId))
    expect(asked).toContain(keyed.id)
    expect(asked).not.toContain(clean.id)
    expect(asked).not.toContain(archived.id)
    expect(errors).toEqual([failing.id])
    expect((await storedMetadata(keyed.id)).integrationRules).toEqual({ linear: [rule('keyed', FIC.id)] })
    expect((await storedMetadata(failing.id)).linear).toEqual([{ teamId: 'FIC' }])
    expect((await storedMetadata(archived.id)).linear).toEqual([{ teamId: 'FIC' }])
  })
})
