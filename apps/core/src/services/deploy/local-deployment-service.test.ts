import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { eq, like } from 'drizzle-orm'
import { db, localDeployments, squads } from '../../db'
import { Squad } from '../../entities/Squad'
import { resolveWorkspaceLayout } from '../sandbox/workspace-layout'
import {
  archiveLocalDeploymentRecord,
  createLocalDeployment,
  getLocalDeployment,
  isValidLocalDeploymentBrowserToken,
  hasActiveLocalDeployments,
  listLiveLocalDeployments,
  listSandboxIdsWithLiveManagedLocalDeployments,
  listLocalDeployments,
  listRestartableManagedLocalDeploymentsForSandbox,
  markLocalDeploymentsStoppedForSandbox,
  stopLocalDeploymentRecord,
} from './local-deployment-service'

describe('localDeployment service', () => {
  let testPrefix: string

  beforeEach(() => {
    testPrefix = `localDeployment-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  })

  afterEach(async () => {
    await db.delete(squads).where(like(squads.name, `${testPrefix}%`))
  })

  async function createTestSquad(name: string): Promise<Squad> {
    const [row] = await db
      .insert(squads)
      .values({ name: `${testPrefix}-${name}`, purpose: 'LocalDeployment service test squad' })
      .returning()
    return new Squad(row)
  }

  it('emits a hosted URL with only the compact deployment prefix', async () => {
    const previousAppsDomain = process.env.FICUS_APPS_DOMAIN
    const previousAppUrl = process.env.APP_URL
    process.env.FICUS_APPS_DOMAIN = 'hiretau.app'
    process.env.APP_URL = 'https://team--blue.hiretau.ai:8443/control'

    try {
      const squad = await createTestSquad('hosted-url')
      const localDeployment = await createLocalDeployment(squad, { name: 'web', port: 5173, mode: 'attached' })
      const compactId = localDeployment.id.replaceAll('-', '').slice(0, 12)
      const url = new URL(localDeployment.urlPathOrHost)

      expect(url.origin).toBe(`https://team--blue--${compactId}.hiretau.app`)
      expect(url.pathname).toBe('/')
      expect(url.searchParams.get('_tau_token')).toBeTruthy()
      expect(url.hostname).not.toContain(localDeployment.id.replaceAll('-', ''))
    } finally {
      if (previousAppsDomain === undefined) delete process.env.FICUS_APPS_DOMAIN
      else process.env.FICUS_APPS_DOMAIN = previousAppsDomain
      if (previousAppUrl === undefined) delete process.env.APP_URL
      else process.env.APP_URL = previousAppUrl
    }
  })

  it('keeps the path fallback byte-for-byte unchanged when the apps domain is unset', async () => {
    const previousAppsDomain = process.env.FICUS_APPS_DOMAIN
    delete process.env.FICUS_APPS_DOMAIN

    try {
      const squad = await createTestSquad('path-fallback')
      const localDeployment = await createLocalDeployment(squad, { name: 'web', port: 5173, mode: 'attached' })
      const token = new URL(`http://tau${localDeployment.urlPathOrHost}`).searchParams.get('_tau_token')

      expect(localDeployment.urlPathOrHost).toBe(
        `/api/app/${localDeployment.id}/?_tau_token=${encodeURIComponent(token!)}`
      )
    } finally {
      if (previousAppsDomain === undefined) delete process.env.FICUS_APPS_DOMAIN
      else process.env.FICUS_APPS_DOMAIN = previousAppsDomain
    }
  })

  it('falls back to the path URL on reads when hosted URL config becomes invalid', async () => {
    const previousAppsDomain = process.env.FICUS_APPS_DOMAIN
    const previousAppUrl = process.env.APP_URL
    delete process.env.FICUS_APPS_DOMAIN
    const warn = spyOn(console, 'warn').mockImplementation(() => {})

    try {
      const squad = await createTestSquad('invalid-hosted-read')
      const created = await createLocalDeployment(squad, { name: 'web', port: 5173, mode: 'attached' })
      const token = new URL(`http://tau${created.urlPathOrHost}`).searchParams.get('_tau_token')!
      process.env.FICUS_APPS_DOMAIN = 'hiretau.app'
      process.env.APP_URL = `https://${'a'.repeat(50)}.hiretau.ai`

      const found = await getLocalDeployment(created.id)
      const listed = await listLocalDeployments(squad.id)
      const expected = `/api/app/${created.id}/?_tau_token=${encodeURIComponent(token)}`
      expect(found?.urlPathOrHost).toBe(expected)
      expect(listed[0]?.urlPathOrHost).toBe(expected)
      expect(warn.mock.calls.flat().join(' ').toLowerCase()).toContain('hosted app url config is invalid')
    } finally {
      warn.mockRestore()
      if (previousAppsDomain === undefined) delete process.env.FICUS_APPS_DOMAIN
      else process.env.FICUS_APPS_DOMAIN = previousAppsDomain
      if (previousAppUrl === undefined) delete process.env.APP_URL
      else process.env.APP_URL = previousAppUrl
    }
  })

  it('fails descriptively for invalid apps domain config', async () => {
    const previousAppsDomain = process.env.FICUS_APPS_DOMAIN
    const previousAppUrl = process.env.APP_URL
    const invalidConfigs = [
      { appsDomain: ' ', appUrl: 'https://team.hiretau.ai', message: 'FICUS_APPS_DOMAIN' },
      { appsDomain: 'https://hiretau.app', appUrl: 'https://team.hiretau.ai', message: 'FICUS_APPS_DOMAIN' },
      { appsDomain: 'hiretau.app', appUrl: 'not a URL', message: 'APP_URL' },
      { appsDomain: 'hiretau.app', appUrl: 'https://localhost', message: 'tenant label' },
      { appsDomain: 'hiretau.app', appUrl: 'https://a.hiretau.ai', message: 'at least 3 characters' },
      { appsDomain: 'hiretau.app', appUrl: 'https://ab.hiretau.ai', message: 'at least 3 characters' },
      { appsDomain: 'hiretau.app', appUrl: `https://${'a'.repeat(50)}.hiretau.ai`, message: '49 characters' },
    ]

    try {
      const squad = await createTestSquad('invalid-hosted-config')
      for (const [index, config] of invalidConfigs.entries()) {
        process.env.FICUS_APPS_DOMAIN = config.appsDomain
        process.env.APP_URL = config.appUrl
        await expect(
          createLocalDeployment(squad, { name: `web-${index}`, port: 5173 + index, mode: 'attached' })
        ).rejects.toThrow(config.message)
      }
      const persisted = await db
        .select({ id: localDeployments.id })
        .from(localDeployments)
        .where(eq(localDeployments.squadId, squad.id))
      expect(persisted).toHaveLength(0)
    } finally {
      if (previousAppsDomain === undefined) delete process.env.FICUS_APPS_DOMAIN
      else process.env.FICUS_APPS_DOMAIN = previousAppsDomain
      if (previousAppUrl === undefined) delete process.env.APP_URL
      else process.env.APP_URL = previousAppUrl
    }
  })

  it('validates browser tokens in constant time without throwing on length mismatch', async () => {
    const squad = await createTestSquad('token')
    const localDeployment = await createLocalDeployment(squad, { name: 'web', port: 5173, mode: 'attached' })
    const rawToken = new URL(`http://t${localDeployment.urlPathOrHost}`).searchParams.get('_tau_token')
    expect(rawToken).toBeTruthy()

    expect(await isValidLocalDeploymentBrowserToken(localDeployment.id, rawToken)).toBe(true)
    // length mismatch must return false, not throw (timingSafeEqual throws on unequal lengths)
    expect(await isValidLocalDeploymentBrowserToken(localDeployment.id, 'short')).toBe(false)
    expect(await isValidLocalDeploymentBrowserToken(localDeployment.id, `${rawToken}x`)).toBe(false)
    expect(await isValidLocalDeploymentBrowserToken(localDeployment.id, null)).toBe(false)
  })

  it('creates a managed localDeployment row with private visibility', async () => {
    const squad = await createTestSquad('create')

    const localDeployment = await createLocalDeployment(squad, { name: 'Web App', port: 5173, command: 'bun run dev' })

    expect(localDeployment.squadId).toBe(squad.id)
    expect(localDeployment.sandboxId).toBe(squad.sandboxId)
    expect(localDeployment.name).toBe('web-app')
    expect(localDeployment.port).toBe(5173)
    expect(localDeployment.visibility).toBe('private')
    expect(localDeployment.mode).toBe('managed')
    expect(localDeployment.status).toBe('starting')
    expect(localDeployment.keepSandboxAlive).toBe(true)
    expect(localDeployment.restartPolicy).toBe('always')
    expect(localDeployment.urlPathOrHost).toMatch(new RegExp(`^/api/app/${localDeployment.id}/\\?_tau_token=.+$`))
  })

  it('createLocalDeployment persists a normalized attached logPath', async () => {
    const squad = await createTestSquad('log-path')

    const localDeployment = await createLocalDeployment(squad, {
      name: 'web',
      port: 5173,
      mode: 'attached',
      logPath: 'my-app/app.log',
    })

    const { workspaceMount } = resolveWorkspaceLayout({ squadId: squad.id })
    expect(localDeployment.logPath).toBe(`${workspaceMount}/my-app/app.log`)
    const persisted = (await getLocalDeployment(localDeployment.id))!
    expect(persisted.logPath).toBe(`${workspaceMount}/my-app/app.log`)
  })

  it('createLocalDeployment leaves logPath null when omitted', async () => {
    const squad = await createTestSquad('no-log-path')

    const localDeployment = await createLocalDeployment(squad, { name: 'web', port: 5173, mode: 'attached' })

    expect(localDeployment.logPath).toBeNull()
  })

  it('createLocalDeployment rejects logPath on managed mode', async () => {
    const squad = await createTestSquad('managed-log-path')

    await expect(
      createLocalDeployment(squad, { name: 'web', command: 'bun run dev', logPath: 'app.log' })
    ).rejects.toThrow(/attached/)
  })

  it('lists localDeployments for only the requested squad', async () => {
    const squad = await createTestSquad('list-a')
    const otherSquad = await createTestSquad('list-b')
    await createLocalDeployment(squad, { name: 'web', port: 5173, command: 'bun run dev' })
    await createLocalDeployment(otherSquad, { name: 'api', port: 3000, command: 'bun run api' })

    const localDeployments = await listLocalDeployments(squad.id)

    expect(localDeployments).toHaveLength(1)
    expect(localDeployments[0].squadId).toBe(squad.id)
    expect(localDeployments[0].name).toBe('web')
  })

  it('lists newest localDeployments first and excludes archived by default', async () => {
    const squad = await createTestSquad('list-order')
    const older = await createLocalDeployment(squad, { name: 'older', port: 5173, command: 'bun run dev' })
    const newer = await createLocalDeployment(squad, {
      name: 'newer',
      port: 5174,
      command: 'bun run dev -- --port 5174',
    })
    await archiveLocalDeploymentRecord(newer.id)

    const activeLocalDeployments = await listLocalDeployments(squad.id)
    expect(activeLocalDeployments.map((localDeployment) => localDeployment.id)).toEqual([older.id])

    const allLocalDeployments = await listLocalDeployments(squad.id, { includeArchived: true })
    expect(allLocalDeployments.map((localDeployment) => localDeployment.id)).toEqual([newer.id, older.id])
  })

  it('gets a localDeployment by id', async () => {
    const squad = await createTestSquad('get')
    const localDeployment = await createLocalDeployment(squad, { name: 'web', port: 5173, command: 'bun run dev' })

    const found = await getLocalDeployment(localDeployment.id)

    expect(found?.id).toBe(localDeployment.id)
    expect(found?.squadId).toBe(squad.id)
    expect(await getLocalDeployment('00000000-0000-0000-0000-000000000000')).toBeNull()
  })

  it('archives a localDeployment row and cleans up keepalive state', async () => {
    const squad = await createTestSquad('archive')
    const localDeployment = await createLocalDeployment(squad, { name: 'web', port: 5173, command: 'bun run dev' })

    const archived = await archiveLocalDeploymentRecord(localDeployment.id)

    expect(archived.status).toBe('stopped')
    expect(archived.keepSandboxAlive).toBe(false)
    expect(archived.processId).toBeNull()
    expect(archived.archivedAt).toBeTruthy()
    expect((await getLocalDeployment(localDeployment.id))?.archivedAt).toBeTruthy()
  })

  it('lists live localDeployments excluding stopped and archived', async () => {
    const squad = await createTestSquad('live')
    const live = await createLocalDeployment(squad, { name: 'live', port: 5173, command: 'bun run dev' })
    const archived = await createLocalDeployment(squad, { name: 'archived', port: 5174, command: 'bun run dev' })
    const stopped = await createLocalDeployment(squad, { name: 'stopped', port: 5175, mode: 'attached' })
    await archiveLocalDeploymentRecord(archived.id)
    await stopLocalDeploymentRecord(stopped.id)

    const localDeployments = await listLiveLocalDeployments()

    expect(localDeployments.map((localDeployment) => localDeployment.id)).toContain(live.id)
    expect(localDeployments.map((localDeployment) => localDeployment.id)).not.toContain(archived.id)
    expect(localDeployments.map((localDeployment) => localDeployment.id)).not.toContain(stopped.id)
  })

  it('lists sandbox ids with live managed localDeployments only', async () => {
    const squad = await createTestSquad('live-managed')
    const live = await createLocalDeployment(squad, { name: 'live', port: 5173, command: 'bun run dev' })
    const archived = await createLocalDeployment(squad, { name: 'archived', port: 5174, command: 'bun run dev' })
    const attached = await createLocalDeployment(squad, { name: 'attached', port: 5175, mode: 'attached' })
    await archiveLocalDeploymentRecord(archived.id)
    await stopLocalDeploymentRecord(attached.id)

    const sandboxIds = await listSandboxIdsWithLiveManagedLocalDeployments()

    expect(sandboxIds).toContain(live.sandboxId)
  })

  it('keeps sandbox-stopped managed localDeployments restartable for the next sandbox start', async () => {
    const squad = await createTestSquad('sandbox-stop-restartable')
    const localDeployment = await createLocalDeployment(squad, { name: 'web', port: 5173, command: 'bun run dev' })

    await markLocalDeploymentsStoppedForSandbox(squad.sandboxId)

    const restartable = await listRestartableManagedLocalDeploymentsForSandbox(squad.sandboxId)
    expect(restartable.map((item) => item.id)).toContain(localDeployment.id)
    expect(restartable[0].status).toBe('crashed')
  })

  it('marks a localDeployment stopped and disables keepSandboxAlive', async () => {
    const squad = await createTestSquad('stop')
    const localDeployment = await createLocalDeployment(squad, { name: 'web', port: 5173, command: 'bun run dev' })

    const stopped = await stopLocalDeploymentRecord(localDeployment.id)

    expect(stopped.status).toBe('stopped')
    expect(stopped.keepSandboxAlive).toBe(false)
  })

  it('returns active localDeployments for idle suppression', async () => {
    const squad = await createTestSquad('active')
    const active = await createLocalDeployment(squad, { name: 'web', port: 5173, command: 'bun run dev' })
    const stopped = await createLocalDeployment(squad, {
      name: 'old-web',
      port: 5174,
      command: 'bun run dev -- --port 5174',
    })
    await stopLocalDeploymentRecord(stopped.id)

    expect(await hasActiveLocalDeployments(squad.sandboxId)).toBe(true)

    await markLocalDeploymentsStoppedForSandbox(squad.sandboxId)

    expect(await hasActiveLocalDeployments(squad.sandboxId)).toBe(false)
    const rows = await db.select().from(localDeployments).where(eq(localDeployments.id, active.id))
    expect(rows[0].status).toBe('crashed')
    expect(rows[0].keepSandboxAlive).toBe(false)
  })
})
