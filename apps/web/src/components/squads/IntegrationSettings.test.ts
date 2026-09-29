import { describe, expect, test } from 'bun:test'
import {
  githubIdentityFromMetadata,
  githubIdentityToMetadata,
  githubRoutingFromMetadata,
  githubRoutingToMetadata,
  linearRoutingFromMetadata,
  linearRoutingToMetadata,
} from './integrationMetadata'

describe('IntegrationSettings GitHub identity metadata', () => {
  test('reads only non-secret GitHub identity fields from squad metadata', () => {
    expect(
      githubIdentityFromMetadata({
        githubIdentity: {
          githubToken: 'must-not-be-read',
          gitUserName: 'Squad Bot',
          gitUserEmail: 'squad@example.com',
        },
      })
    ).toEqual({
      gitUserName: 'Squad Bot',
      gitUserEmail: 'squad@example.com',
    })
  })

  test('writes only git author fields without clobbering other metadata', () => {
    expect(
      githubIdentityToMetadata(
        { sandbox: { alwaysOn: true }, githubIdentity: { githubToken: 'remove-me' } },
        { gitUserName: 'Squad Bot', gitUserEmail: 'squad@example.com' }
      )
    ).toEqual({
      sandbox: { alwaysOn: true },
      githubIdentity: {
        gitUserName: 'Squad Bot',
        gitUserEmail: 'squad@example.com',
      },
    })
  })
})

describe('IntegrationSettings GitHub routing metadata', () => {
  test('reads GitHub repo routing entries from squad metadata', () => {
    const entries = githubRoutingFromMetadata({
      github: [{ repo: 'ficus/app' }, { repo: 'ficus/api', labels: ['backend', 'api'] }],
    })

    expect(entries).toEqual([
      { repo: 'ficus/app', labelsText: '' },
      { repo: 'ficus/api', labelsText: 'backend, api' },
    ])
  })

  test('writes GitHub repo routing entries without clobbering other metadata', () => {
    const metadata = githubRoutingToMetadata({ sandbox: { alwaysOn: true } }, [
      { repo: 'ficus/app', labelsText: '' },
      { repo: 'ficus/api', labelsText: 'backend, api' },
    ])

    expect(metadata).toEqual({
      sandbox: { alwaysOn: true },
      github: [{ repo: 'ficus/app' }, { repo: 'ficus/api', labels: ['backend', 'api'] }],
    })
  })
})

describe('IntegrationSettings Linear routing metadata', () => {
  test('reads Linear team routing entries from squad metadata', () => {
    expect(linearRoutingFromMetadata({ linear: [{ teamId: 'team-a' }, { teamId: 'team-b' }] })).toEqual([
      { teamId: 'team-a' },
      { teamId: 'team-b' },
    ])
  })

  test('writes Linear team routing entries without clobbering other metadata', () => {
    expect(
      linearRoutingToMetadata({ github: [{ repo: 'ficus/app' }] }, [{ teamId: 'team-a' }, { teamId: '' }])
    ).toEqual({
      github: [{ repo: 'ficus/app' }],
      linear: [{ teamId: 'team-a' }],
    })
  })
})
