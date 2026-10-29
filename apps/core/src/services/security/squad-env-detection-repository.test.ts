import { afterEach, beforeEach, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq, sql } from 'drizzle-orm'
import { db, squadEnvDetections, squads } from '../../db'
import { Squad } from '../../entities/Squad'
import { listPeriodicRunnerNames, listPeriodicRunners } from '../../lib/infra/PeriodicRunner'
import { ContentSafetyRegistry } from './content-safety-registry'
import { DbSquadEnvDetectionRepository, MAX_SQUAD_ENV_BYTES } from './squad-env-detection-repository'
import { SquadEnvSecretSource } from './squad-env-secret-source'

let id: string
let root: string
let file: string
let now: number
let originalKey: string | undefined
const sources: SquadEnvSecretSource[] = []
const warnings: string[] = []
const repository = new DbSquadEnvDetectionRepository()
const hash = (value: string) => createHash('sha256').update(value).digest('hex')

function source() {
  const instance = new SquadEnvSecretSource(() => root, {
    repository,
    now: () => now,
    warn: (message) => {
      warnings.push(message)
    },
  })
  sources.push(instance)
  return instance
}

beforeEach(async () => {
  originalKey = process.env.FICUS_ENCRYPTION_KEY
  delete process.env.FICUS_ENCRYPTION_KEY
  warnings.length = 0
  now = 10_000
  const [row] = await db
    .insert(squads)
    .values({ name: 'trusted-env-synthetic', purpose: 'synthetic detection test' })
    .returning({ id: squads.id })
  id = row.id
  root = mkdtempSync(join(tmpdir(), 'trusted-env-'))
  mkdirSync(join(root, id, '.ficus'), { recursive: true })
  file = join(root, id, '.ficus', 'env.user')
})

afterEach(async () => {
  for (const instance of sources.splice(0)) await instance.stop()
  await db.delete(squads).where(eq(squads.id, id))
  rmSync(root, { recursive: true, force: true })
  if (originalKey === undefined) delete process.env.FICUS_ENCRYPTION_KEY
  else process.env.FICUS_ENCRYPTION_KEY = originalKey
})

test('no-key startup snapshots legacy env once into protected DB state and keeps output-only detection', async () => {
  const content = 'APP_TOKEN=synthetic-legacy-protected-token'
  writeFileSync(file, content)
  const instance = source()
  await instance.initialize()
  const [stored] = await db.select().from(squadEnvDetections).where(eq(squadEnvDetections.squadId, id))
  const [squad] = await db.select().from(squads).where(eq(squads.id, id))
  expect(squad.envDetectionBootstrapped).toBe(true)
  expect(stored.contentHash).toBe(hash(content))
  expect(stored.entries).toEqual([{ key: 'APP_TOKEN', value: 'synthetic-legacy-protected-token' }])
  const registry = new ContentSafetyRegistry(
    {
      bindContentSafetyConsumer(consumer) {
        consumer.replace([])
        return () => {}
      },
    },
    instance
  )
  try {
    expect(registry.redact('synthetic-legacy-protected-token')).not.toContain('synthetic-legacy-protected-token')
    expect(registry.redactWithStoredKeys('synthetic-legacy-protected-token').storedKeys).toEqual([])
  } finally {
    registry.dispose()
  }
})

test('later disk edits and a deleted trusted row never get bootstrapped again after restart', async () => {
  const content = 'APP_TOKEN=synthetic-initial-protected-token'
  writeFileSync(file, content)
  await source().initialize()
  writeFileSync(file, 'APP_TOKEN=synthetic-untrusted-disk-token')
  const restarted = source()
  await restarted.initialize()
  expect(restarted.entries()).toEqual([])
  expect(restarted.notice(id)).toContain('outside Settings')
  expect((await repository.list()).find((row) => row.squadId === id)?.snapshot?.contentHash).toBe(hash(content))
  await db.delete(squadEnvDetections).where(eq(squadEnvDetections.squadId, id))
  await restarted.initialize()
  expect(restarted.entries()).toEqual([])
  expect(restarted.notice(id)).toContain('trusted state')
  expect(await repository.pendingSquads()).not.toContain(id)
  expect(await db.select().from(squadEnvDetections).where(eq(squadEnvDetections.squadId, id))).toEqual([])
})

test('malformed trusted state is ignored without treating it as a fresh legacy environment', async () => {
  writeFileSync(file, 'APP_TOKEN=synthetic-corrupt-record-token')
  await source().initialize()
  await db
    .update(squadEnvDetections)
    .set({ entries: sql`'{"invalid":true}'::jsonb` })
    .where(eq(squadEnvDetections.squadId, id))
  const restarted = source()
  await restarted.initialize()
  expect(restarted.entries()).toEqual([])
  expect(restarted.notice(id)).toContain('trusted state')
  expect(await repository.pendingSquads()).not.toContain(id)
})

test('no-key service writes update disk and trusted state; concurrent bootstrap cannot replace API authority', async () => {
  const instance = source()
  const content = 'APP_TOKEN=synthetic-authoritative-api-token'
  await Promise.all([
    repository.bootstrap(id, {
      contentHash: hash('old'),
      entries: [{ key: 'APP_TOKEN', value: 'synthetic-old-bootstrap-token' }],
      reason: null,
    }),
    instance.recordWrite(id, content, () => writeFileSync(file, content)),
  ])
  const [record] = await db.select().from(squadEnvDetections).where(eq(squadEnvDetections.squadId, id))
  expect(record.contentHash).toBe(hash(content))
  expect(instance.entries().map(({ value }) => value)).toContain('synthetic-authoritative-api-token')
  const peer = source()
  await peer.initialize()
  expect(peer.entries().map(({ value }) => value)).toContain('synthetic-authoritative-api-token')
})

test('oversized legacy state is durably skipped/warned and service cap prevents any write side effect', async () => {
  writeFileSync(file, 'APP_TOKEN=synthetic-oversized-legacy-token\n#' + 'x'.repeat(MAX_SQUAD_ENV_BYTES))
  const instance = source()
  await instance.initialize()
  expect(instance.entries()).toEqual([])
  expect(instance.notice(id)).toContain('256 KiB')
  expect(warnings.filter((message) => message.includes(id))).toHaveLength(1)
  now += 1000
  instance.entries()
  expect(warnings.filter((message) => message.includes(id))).toHaveLength(1)
  const [record] = await db.select().from(squadEnvDetections).where(eq(squadEnvDetections.squadId, id))
  expect(record).toMatchObject({ contentHash: null, entries: [], reason: 'oversized' })
  let wrote = false
  await expect(
    instance.recordWrite(id, 'é'.repeat(MAX_SQUAD_ENV_BYTES / 2 + 1), () => {
      wrote = true
    })
  ).rejects.toThrow('256 KiB')
  expect(wrote).toBe(false)
})

test('generic squad mutation cannot reset the protected bootstrap marker', async () => {
  await repository.save(id, { contentHash: null, entries: [], reason: null })
  await expect(Squad.update(id, { envDetectionBootstrapped: false } as never)).rejects.toThrow(
    'Reserved env detection state'
  )
  expect(await repository.pendingSquads()).not.toContain(id)
})

test('periodic DB refresh is an owned stoppable lifecycle rather than work launched by log redaction', async () => {
  const instance = source()
  await instance.initialize()
  instance.start()
  expect(listPeriodicRunnerNames()).toContain('squad-env-detection')
  const runner = listPeriodicRunners().find((runner) => runner.runnerName === 'squad-env-detection')!
  expect(runner.runnerIntervalMs).toBeGreaterThanOrEqual(10_000)
  expect(runner.runnerIntervalMs).toBeLessThanOrEqual(30_000)
  await instance.stop()
  expect(listPeriodicRunnerNames()).not.toContain('squad-env-detection')
})

test('API edits refresh another process through protected DB state without blessing direct disk changes', async () => {
  const writer = source()
  await writer.recordWrite(id, 'APP_TOKEN=synthetic-old-peer-token', () =>
    writeFileSync(file, 'APP_TOKEN=synthetic-old-peer-token')
  )
  const peer = source()
  await peer.initialize()
  await writer.recordWrite(id, 'APP_TOKEN=synthetic-new-peer-token', () =>
    writeFileSync(file, 'APP_TOKEN=synthetic-new-peer-token')
  )
  expect(writer.entries().map(({ value }) => value)).toContain('synthetic-new-peer-token')
  now += 1000
  await peer.refresh()
  expect(peer.entries().map(({ value }) => value)).toEqual(['synthetic-new-peer-token'])
  writeFileSync(file, 'APP_TOKEN=synthetic-untrusted-peer-token')
  now += 1000
  await peer.refresh()
  expect(peer.entries()).toEqual([])
  expect(peer.notice(id)).toContain('outside Settings')
})

test('a squad deleted during bootstrap does not abort startup or recreate its state', async () => {
  await db.delete(squads).where(eq(squads.id, id))
  await expect(repository.bootstrap(id, { contentHash: null, entries: [], reason: null })).resolves.toBeUndefined()
  expect(await db.select().from(squadEnvDetections).where(eq(squadEnvDetections.squadId, id))).toEqual([])
})

test('Squad hydration includes the protected bootstrap marker without exposing it in public JSON', async () => {
  await repository.save(id, { contentHash: null, entries: [], reason: null })
  const squad = await Squad.mustFind(id)
  expect(squad.envDetectionBootstrapped).toBe(true)
  expect((await Squad.findManyByIds([id])).get(id)?.envDetectionBootstrapped).toBe(true)
  expect(Object.hasOwn(squad.toJson(), 'envDetectionBootstrapped')).toBe(false)
})
