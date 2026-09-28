import { afterEach, describe, expect, test } from 'bun:test'
import { sql } from 'drizzle-orm'
import { db } from '../../../db'
import { inbox } from '../../../db/schema'
import { SandboxDeathNotifier } from './notifier'
import type { SandboxDeathClassification, SandboxDeathObservation } from './types'

const obs: SandboxDeathObservation = {
  sandboxId: 'squad_abc',
  signal: 'failed',
  reason: 'NodeLost',
  runtime: 'k8s',
  startedAt: '2026-01-01T00:00:00Z',
}

function makeNotifier(classification: SandboxDeathClassification) {
  const sent: any[] = []
  const n = new SandboxDeathNotifier({
    classify: () => classification,
    send: async (m) => {
      sent.push(m)
      return undefined
    },
    resolveSquadName: async () => 'Ficus',
  })
  return { n, sent }
}

async function deleteSandboxDeathMessages(sandboxId = obs.sandboxId) {
  await db
    .delete(inbox)
    .where(sql`${inbox.metadata}->>'source' = 'sandbox-death' AND ${inbox.metadata}->>'sandboxId' = ${sandboxId}`)
}

describe('SandboxDeathNotifier', () => {
  afterEach(async () => {
    await deleteSandboxDeathMessages()
  })
  test('sends one notification for an unexpected death', async () => {
    const { n, sent } = makeNotifier('unexpected')
    expect((await n.maybeNotify(obs)).notified).toBe(true)
    expect(sent).toHaveLength(1)
    expect(sent[0].recipientType).toBe('system')
    expect(sent[0].content).toContain('Ficus')
    expect(sent[0].content).toContain('stopped unexpectedly')
    expect(sent[0].content).not.toContain('exceeded its memory limit')
  })

  test('sends an actionable OOM notification for an OOM death', async () => {
    const { n, sent } = makeNotifier('oom')
    expect((await n.maybeNotify({ ...obs, reason: 'OOMKilled', exitCode: 137, memoryLimit: '4Gi' })).notified).toBe(
      true
    )
    expect(sent).toHaveLength(1)
    expect(sent[0].subject).toContain('OOM')
    expect(sent[0].content).toContain('exceeded its memory limit')
    expect(sent[0].content).toContain('4Gi')
    expect(sent[0].content).toContain('reduce the command scope')
    expect(sent[0].content).toContain('requesting a higher memory limit')
  })

  test('dedupe distinguishes OOM and generic classifications for the same sandbox death details', async () => {
    const sent: any[] = []
    const claimed = new Set<string>()
    const make = (classification: SandboxDeathClassification) =>
      new SandboxDeathNotifier({
        classify: () => classification,
        send: async (m) => {
          sent.push(m)
          return undefined
        },
        resolveSquadName: async () => 'Ficus',
        dedupe: {
          async claim(key, notify) {
            if (claimed.has(key)) return false
            claimed.add(key)
            await notify()
            return true
          },
        },
      })

    expect((await make('unexpected').maybeNotify(obs)).notified).toBe(true)
    expect((await make('oom').maybeNotify(obs)).notified).toBe(true)
    expect(sent).toHaveLength(2)
    expect(sent[0].metadata.signature).not.toBe(sent[1].metadata.signature)
  })

  test('dedupes the same death event', async () => {
    const { n, sent } = makeNotifier('unexpected')
    await n.maybeNotify(obs)
    expect((await n.maybeNotify(obs)).notified).toBe(false)
    expect(sent).toHaveLength(1)
  })

  test('re-notifies for a distinct sandbox death event', async () => {
    const { n, sent } = makeNotifier('unexpected')
    await n.maybeNotify(obs)
    await n.maybeNotify({ ...obs, startedAt: '2026-01-02T00:00:00Z' })
    expect(sent).toHaveLength(2)
  })

  test('re-notifies after clear() (sandbox recreated then died again)', async () => {
    const { n, sent } = makeNotifier('unexpected')
    await n.maybeNotify(obs)
    n.clear(obs.sandboxId)
    await n.maybeNotify({ ...obs, startedAt: '2026-01-02T00:00:00Z' })
    expect(sent).toHaveLength(2)
  })

  test('dedupes the same death event across notifier instances sharing persistent dedupe', async () => {
    const sent: any[] = []
    const claimed = new Set<string>()
    const make = () =>
      new SandboxDeathNotifier({
        classify: () => 'unexpected',
        send: async (m) => {
          sent.push(m)
          return undefined
        },
        resolveSquadName: async () => 'Ficus',
        dedupe: {
          async claim(key, notify) {
            if (claimed.has(key)) return false
            claimed.add(key)
            await notify()
            return true
          },
        },
      })

    const first = make()
    const second = make()

    expect((await first.maybeNotify(obs)).notified).toBe(true)
    expect((await second.maybeNotify(obs)).notified).toBe(false)
    expect(sent).toHaveLength(1)
  })

  test('serializes concurrent duplicate death notifications through persistent dedupe', async () => {
    const sent: any[] = []
    const claimed = new Set<string>()
    const make = () =>
      new SandboxDeathNotifier({
        classify: () => 'unexpected',
        send: async (m) => {
          await new Promise((resolve) => setTimeout(resolve, 10))
          sent.push(m)
          return undefined
        },
        resolveSquadName: async () => 'Ficus',
        dedupe: {
          async claim(key, notify) {
            if (claimed.has(key)) return false
            claimed.add(key)
            await notify()
            return true
          },
        },
      })

    const results = await Promise.all([make().maybeNotify(obs), make().maybeNotify(obs), make().maybeNotify(obs)])

    expect(results.filter((result) => result.notified)).toHaveLength(1)
    expect(sent).toHaveLength(1)
  })

  test('default persistent dedupe stores only one inbox message for repeated observers', async () => {
    const make = () =>
      new SandboxDeathNotifier({
        classify: () => 'unexpected',
        resolveSquadName: async () => 'Ficus',
      })

    const results = await Promise.all([make().maybeNotify(obs), make().maybeNotify(obs), make().maybeNotify(obs)])
    const rows = await db
      .select({ id: inbox.id })
      .from(inbox)
      .where(sql`${inbox.metadata}->>'source' = 'sandbox-death' AND ${inbox.metadata}->>'sandboxId' = ${obs.sandboxId}`)

    expect(results.filter((result) => result.notified)).toHaveLength(1)
    expect(rows).toHaveLength(1)
  })

  test('does not notify intentional stops', async () => {
    const { n, sent } = makeNotifier('intentional')
    expect((await n.maybeNotify(obs)).notified).toBe(false)
    expect(sent).toHaveLength(0)
  })

  test('does not notify ignored (non-squad) deaths', async () => {
    const { n, sent } = makeNotifier('ignored')
    expect((await n.maybeNotify(obs)).notified).toBe(false)
    expect(sent).toHaveLength(0)
  })

  // The runtime vocabulary on SandboxDeathObservation is widened to the
  // shared SandboxRuntime set (vm/host included, 'docker' kept as a legacy
  // coarse label). This assertion passes even against the old narrow type —
  // TS unions are not enforced at runtime — so it PINS the widened
  // vocabulary going forward; the load-bearing gate for the type itself is
  // CI's typecheck at the exact head.
  test('renders the vm and host runtime labels in the death message', async () => {
    for (const runtime of ['vm', 'host'] as const) {
      const { n, sent } = makeNotifier('unexpected')
      expect((await n.maybeNotify({ ...obs, runtime })).notified).toBe(true)
      expect(sent).toHaveLength(1)
      expect(sent[0].content).toContain(`- Runtime: ${runtime}`)
    }
  })
})
