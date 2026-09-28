import { afterEach, describe, expect, test } from 'bun:test'
import { messageSortAt } from '@ficus/shared'
import { asc, eq, sql } from 'drizzle-orm'
import { db } from '../db'
import { agents, agentTypes, messages } from '../db/schema'
import { Agent } from './Agent'
import { AgentType } from './AgentType'
import { messageSortAtSql } from './message-time'

const typeId = `message-time-${crypto.randomUUID()}`
let agentId: string | undefined

afterEach(async () => {
  if (agentId) await db.delete(agents).where(eq(agents.id, agentId))
  await db.delete(agentTypes).where(eq(agentTypes.id, typeId))
})

describe('messageSortAtSql', () => {
  test('matches TypeScript effective time and ID ordering at millisecond precision', async () => {
    await AgentType.create({
      id: typeId,
      model: 'anthropic:claude-sonnet-4-5',
      name: 'Message time test',
      systemPrompt: 'Test.',
    })
    agentId = (await Agent.create({ agentTypeId: typeId })).id

    const rows = [
      {
        id: '00000000-0000-4000-8000-000000000001',
        agentId,
        role: 'human' as const,
        content: 'human',
        createdAt: new Date('2026-08-10T10:00:00.000Z'),
        metadata: { consumedAt: '2026-08-10T10:30:00.123456Z' },
      },
      {
        id: 'ffffffff-ffff-4fff-bfff-ffffffffffff',
        agentId,
        role: 'assistant' as const,
        content: 'assistant',
        createdAt: new Date('2026-08-10T10:30:00.123Z'),
        metadata: { consumedAt: '2026-08-10T12:00:00.000Z' },
      },
    ]

    expect(rows[0]!.createdAt.getTime()).not.toBe(Date.parse(rows[0]!.metadata.consumedAt))
    expect(messageSortAt(rows[0]!)).toBe(messageSortAt(rows[1]!))

    // Reverse physical insertion order so it cannot accidentally satisfy the ID tie-break.
    await db.insert(messages).values([...rows].reverse())

    const selected = await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL TIME ZONE 'America/Los_Angeles'`)
      return tx
        .select({ id: messages.id, sortAt: messageSortAtSql })
        .from(messages)
        .where(eq(messages.agentId, agentId!))
        .orderBy(asc(messageSortAtSql), asc(messages.id))
    })

    expect(selected.map(({ id }) => id)).toEqual(rows.map(({ id }) => id))
    expect(selected.map(({ sortAt }) => sortAt.getTime())).toEqual(rows.map(messageSortAt))
  })
})
