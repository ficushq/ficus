import { describe, expect, mock, test } from 'bun:test'
import type { LinearTeamDirectory, LinearTeamListingConnection } from '@ficus/shared'
import {
  LinearTeamRouteError,
  isLinearTeamId,
  linearEventRuleTeamKeys,
  linearEventRuleTeamValues,
  linearRouteTeamValues,
  resolveLinearEventRuleTeams,
  resolveLinearTeamRoutes,
} from './team-routes'

const FIC = { id: 'b12ad78a-15d3-46d6-8e65-ff55674de3ba', key: 'FIC', name: 'Ficus', connectionIds: ['c1'] }
const ENG = { id: '0d6c3a1e-7f0b-4d61-9a4e-2b7c5e9f1a23', key: 'ENG', name: 'Engineering', connectionIds: ['c1'] }
const UNKNOWN_ID = '7e0f6b52-3c1d-4f7a-8b9e-1d2c3b4a5f60'

function connection(overrides: Partial<LinearTeamListingConnection> = {}): LinearTeamListingConnection {
  return { id: 'c1', displayName: 'Linear', isDefault: true, status: 'ok', ...overrides }
}

function lister(directory: LinearTeamDirectory) {
  return mock(async () => directory)
}

const listed = { teams: [FIC, ENG], connections: [connection()] }

describe('isLinearTeamId', () => {
  test('accepts UUIDs and rejects team keys', () => {
    expect(isLinearTeamId(FIC.id)).toBe(true)
    expect(isLinearTeamId(FIC.id.toUpperCase())).toBe(true)
    expect(isLinearTeamId('FIC')).toBe(false)
    expect(isLinearTeamId('team-eng')).toBe(false)
  })
})

describe('linearRouteTeamValues', () => {
  test('reads arrays and a single route object, skipping blanks', () => {
    expect(linearRouteTeamValues([{ teamId: 'FIC' }, { teamId: ' ' }, { other: 1 }, null])).toEqual(['FIC'])
    expect(linearRouteTeamValues({ teamId: FIC.id })).toEqual([FIC.id])
    expect(linearRouteTeamValues(undefined)).toEqual([])
  })
})

describe('resolveLinearTeamRoutes', () => {
  test('a team key is stored as the team ID, matched case-insensitively', async () => {
    const listTeams = lister(listed)
    expect(await resolveLinearTeamRoutes({ routes: [{ teamId: 'fic' }], stored: [], listTeams })).toEqual([
      { teamId: FIC.id },
    ])
    expect(listTeams).toHaveBeenCalledTimes(1)
  })

  test('a listed team ID is stored unchanged', async () => {
    expect(
      await resolveLinearTeamRoutes({ routes: [{ teamId: ENG.id }], stored: [], listTeams: lister(listed) })
    ).toEqual([{ teamId: ENG.id }])
  })

  test('already stored team IDs need no Linear call', async () => {
    const listTeams = lister(listed)
    const routes = [{ teamId: FIC.id }, { teamId: UNKNOWN_ID }]
    expect(await resolveLinearTeamRoutes({ routes, stored: [FIC.id, UNKNOWN_ID], listTeams })).toEqual(routes)
    expect(listTeams).not.toHaveBeenCalled()
  })

  test('a key and its ID saved together collapse into one route, keeping other route fields', async () => {
    expect(
      await resolveLinearTeamRoutes({
        routes: [{ teamId: 'FIC' }, { teamId: FIC.id }, { teamId: 'ENG', note: 'x' }],
        stored: [],
        listTeams: lister(listed),
      })
    ).toEqual([{ teamId: FIC.id }, { teamId: ENG.id, note: 'x' }])
  })

  test('a single route object is resolved in place', async () => {
    expect(await resolveLinearTeamRoutes({ routes: { teamId: 'ENG' }, stored: [], listTeams: lister(listed) })).toEqual(
      {
        teamId: ENG.id,
      }
    )
  })

  test('null clears the routes without calling Linear', async () => {
    const listTeams = lister(listed)
    expect(await resolveLinearTeamRoutes({ routes: null, stored: ['FIC'], listTeams })).toBeNull()
    expect(listTeams).not.toHaveBeenCalled()
  })

  test('an unknown team key is rejected with a clear error', async () => {
    const result = resolveLinearTeamRoutes({ routes: [{ teamId: 'NOPE' }], stored: [], listTeams: lister(listed) })
    await expect(result).rejects.toBeInstanceOf(LinearTeamRouteError)
    await expect(result).rejects.toThrow(
      'Ficus could not resolve Linear team key NOPE to a team ID: it is not among the teams Ficus could list.'
    )
  })

  test('an unknown team ID is rejected when every connection listed all its teams', async () => {
    await expect(
      resolveLinearTeamRoutes({ routes: [{ teamId: UNKNOWN_ID }], stored: [], listTeams: lister(listed) })
    ).rejects.toThrow(`Linear team ${UNKNOWN_ID} is not a team the squad's Linear connections can see.`)
  })

  test('an unknown team ID is kept when the listing was partial', async () => {
    for (const connections of [
      [connection({ truncated: true })],
      [connection(), connection({ id: 'c2', status: 'error', error: 'rate_limited' })],
    ]) {
      expect(
        await resolveLinearTeamRoutes({
          routes: [{ teamId: UNKNOWN_ID }],
          stored: [],
          listTeams: lister({ teams: [FIC], connections }),
        })
      ).toEqual([{ teamId: UNKNOWN_ID }])
    }
  })

  test('a new key cannot be stored when no connection can list teams', async () => {
    await expect(
      resolveLinearTeamRoutes({
        routes: [{ teamId: 'FIC' }],
        stored: [],
        listTeams: lister({ teams: [], connections: [] }),
      })
    ).rejects.toThrow('the squad has no Linear connection to look it up with')
    await expect(
      resolveLinearTeamRoutes({
        routes: [{ teamId: 'FIC' }],
        stored: [],
        listTeams: lister({ teams: [], connections: [connection({ status: 'error', error: 'invalid_auth' })] }),
      })
    ).rejects.toThrow('the squad’s Linear connection could not list its teams')
  })

  test('a stored key is resolved when possible and otherwise kept, so unrelated saves still succeed', async () => {
    expect(
      await resolveLinearTeamRoutes({ routes: [{ teamId: 'FIC' }], stored: ['FIC'], listTeams: lister(listed) })
    ).toEqual([{ teamId: FIC.id }])
    expect(
      await resolveLinearTeamRoutes({
        routes: [{ teamId: 'FIC' }, { teamId: 'GONE' }],
        stored: ['FIC', 'GONE'],
        listTeams: lister({ teams: [], connections: [connection({ status: 'error', error: 'provider_unavailable' })] }),
      })
    ).toEqual([{ teamId: 'FIC' }, { teamId: 'GONE' }])
  })
})

function rule(id: string, teamId?: string) {
  return {
    id,
    enabled: true,
    source: { integration: 'linear', output: 'issue.assigned', version: 1 },
    filters: { squadRouting: false, audience: 'any', ...(teamId === undefined ? {} : { teamId }) },
    action: { type: 'notify-manager' },
  }
}

describe('linearEventRuleTeamValues and linearEventRuleTeamKeys', () => {
  test('read team filters from rule lists only, and name the rules whose filter is a key', () => {
    const rules = [rule('a', 'FIC'), rule('b', FIC.id), rule('c'), rule('d', ' '), null, 'junk']
    expect(linearEventRuleTeamValues(rules)).toEqual(['FIC', FIC.id])
    expect(linearEventRuleTeamValues({ filters: { teamId: 'FIC' } })).toEqual([])
    expect(linearEventRuleTeamKeys(rules)).toEqual([{ ruleId: 'a', value: 'FIC' }])
    expect(linearEventRuleTeamKeys(undefined)).toEqual([])
  })
})

describe('resolveLinearEventRuleTeams', () => {
  test('a team key filter is stored as the team ID, keeping the rest of the rule', async () => {
    const listTeams = lister(listed)
    const resolved = await resolveLinearEventRuleTeams({
      rules: [rule('keyed', 'fic'), rule('any')],
      stored: [],
      listTeams,
    })
    expect(resolved).toEqual([rule('keyed', FIC.id), rule('any')])
    expect(listTeams).toHaveBeenCalledTimes(1)
  })

  test('a listed team ID filter is stored unchanged', async () => {
    expect(
      await resolveLinearEventRuleTeams({ rules: [rule('by-id', ENG.id)], stored: [], listTeams: lister(listed) })
    ).toEqual([rule('by-id', ENG.id)])
  })

  test('rules without a team filter, stored IDs and non-lists need no Linear call', async () => {
    const listTeams = lister(listed)
    const rules = [rule('any'), rule('stored', UNKNOWN_ID)]
    expect(await resolveLinearEventRuleTeams({ rules, stored: [UNKNOWN_ID], listTeams })).toBe(rules)
    expect(await resolveLinearEventRuleTeams({ rules: null, stored: [], listTeams })).toBeNull()
    expect(listTeams).not.toHaveBeenCalled()
  })

  test('an unknown team key is rejected with a message naming the rule and the key', async () => {
    const result = resolveLinearEventRuleTeams({
      rules: [rule('fine', 'ENG'), rule('typo', 'NOPE')],
      stored: [],
      listTeams: lister(listed),
    })
    await expect(result).rejects.toBeInstanceOf(LinearTeamRouteError)
    await expect(result).rejects.toThrow(
      'Linear event rule typo has an invalid team filter. Ficus could not resolve Linear team key NOPE to a team ID: it is not among the teams Ficus could list.'
    )
  })

  test('an unknown team ID is rejected when every connection listed all its teams', async () => {
    await expect(
      resolveLinearEventRuleTeams({ rules: [rule('gone', UNKNOWN_ID)], stored: [], listTeams: lister(listed) })
    ).rejects.toThrow(
      `Linear event rule gone has an invalid team filter. Linear team ${UNKNOWN_ID} is not a team the squad's Linear connections can see.`
    )
  })

  test('a stored key filter is resolved when possible and otherwise kept, so unrelated saves still succeed', async () => {
    expect(
      await resolveLinearEventRuleTeams({ rules: [rule('old', 'FIC')], stored: ['FIC'], listTeams: lister(listed) })
    ).toEqual([rule('old', FIC.id)])
    const rules = [rule('old', 'FIC')]
    expect(
      await resolveLinearEventRuleTeams({
        rules,
        stored: ['FIC'],
        listTeams: lister({ teams: [], connections: [] }),
      })
    ).toBe(rules)
  })
})
