import { describe, expect, it } from 'bun:test'
import type { LocalDeployment } from '@ficus/shared'
import { appBrowserUrl, squadApps, type RemoteDeployment } from './apps'

const remote = (o: Partial<RemoteDeployment>): RemoteDeployment => ({
  id: 'r1',
  squadId: 'sq',
  name: 'Site',
  provider: 'vercel',
  environment: 'preview',
  status: 'ready',
  url: 'https://site.example.com',
  ...o,
})
const local = (o: Partial<LocalDeployment>): LocalDeployment =>
  ({
    id: 'l1',
    squadId: 'sq',
    name: 'Dev server',
    urlPathOrHost: '/api/app/l1/?token=abc',
    status: 'running',
    ...o,
  }) as LocalDeployment

describe('squad apps', () => {
  it('combine remote deployments with a URL and live local apps, remote first, by name', () => {
    const apps = squadApps(
      [remote({ id: 'b', name: 'Beta' }), remote({ id: 'a', name: 'Alpha' }), remote({ id: 'x', url: null })],
      [
        local({ id: 'dev', name: 'Dev' }),
        local({ id: 'old', status: 'stopped' }),
        local({ id: 'gone', archivedAt: '2026-09-01T00:00:00Z' }),
      ]
    )
    expect(apps.map((app) => [app.id, app.kind])).toEqual([
      ['remote:a', 'remote'],
      ['remote:b', 'remote'],
      ['local:dev', 'local'],
    ])
    expect(apps[0]).toMatchObject({ where: 'vercel · preview', url: 'https://site.example.com' })
    expect(apps[2]).toMatchObject({ where: 'Sandbox', url: '/api/app/l1/?token=abc' })
  })

  it('leave archived remote deployments out', () => {
    expect(squadApps([remote({ archivedAt: '2026-09-01T00:00:00Z' })], [])).toEqual([])
  })

  it('open local apps under the instance, keeping their access token', () => {
    expect(appBrowserUrl('/api/app/l1/?token=abc', '', 'https://acme.ficus.sh')).toBe(
      'https://acme.ficus.sh/api/app/l1/?token=abc'
    )
    expect(appBrowserUrl('/api/app/l1/?token=abc', '/ficus', 'https://example.com')).toBe(
      'https://example.com/ficus/api/app/l1/?token=abc'
    )
    expect(appBrowserUrl('https://site.example.com', '/ficus', 'https://example.com')).toBe('https://site.example.com')
  })
})
