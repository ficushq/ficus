import { afterEach, describe, expect, it } from 'bun:test'
import { eq, inArray } from 'drizzle-orm'
import { db } from '../db'
import { squads, workStreams } from '../db/schema'
import { ChannelInstance } from './ChannelInstance'

function instance(overrides: Partial<ChannelInstance> = {}): ChannelInstance {
  return new ChannelInstance({
    id: 'ci1',
    name: 'CI',
    provider: 'slack',
    providerConfig: {},
    channelSquadMap: {},
    defaultSquadId: null,
    yamlTemplate: null,
    yamlFieldOverrides: [],
    disabled: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as any)
}

function inbound(channelId: string) {
  return {
    command: 'ask',
    content: 'hello',
    user: { id: 'u1', name: 'User' },
    responseContext: { provider: 'slack', channelId },
  } as any
}

describe('ChannelInstance.resolveTargetSquadOrThrow', () => {
  it('uses a channel-map override then falls back to default', () => {
    const inst = instance({
      defaultSquadId: 'default',
      channelSquadMap: { 'C-FE': 'frontend' },
    })

    expect(inst.resolveTargetSquadOrThrow(inbound('C-FE'))).toBe('frontend')
    expect(inst.resolveTargetSquadOrThrow(inbound('C-OTHER'))).toBe('default')
  })

  it('does not fall back to linked squads', () => {
    const inst = instance()

    expect(inst.hasResolvableDefault()).toBe(false)
    expect(() => inst.resolveTargetSquadOrThrow(inbound('C1'))).toThrow(/no resolvable target squad/i)
  })
})

describe('ChannelInstance.buildChannelInboxMessage', () => {
  it('includes Slack current-thread context and ingest command guidance', async () => {
    const inst = instance()
    const content = await (inst as any).buildChannelInboxMessage(
      {
        command: 'mention',
        content: 'index this thread',
        user: { id: 'u1', name: 'User' },
        responseContext: {
          provider: 'slack',
          channelId: 'C123',
          threadId: '1710000000.000100',
          extras: {
            teamId: 'T123',
            channelId: 'C123',
            messageTs: '1710000001.000200',
            threadTs: '1710000000.000100',
            permalink: 'https://acme.slack.com/archives/C123/p1710000000000100',
          },
        },
      },
      'squad-1'
    )

    expect(content).toContain('Channel context (Slack)')
    expect(content).toContain('channelId: `C123`')
    expect(content).toContain('thread_ts: `1710000000.000100`')
    expect(content).toContain('--from-slack https://acme.slack.com/archives/C123/p1710000000000100')
    expect(content).toContain(
      'ficus squad memory ingest squad-1 https://acme.slack.com/archives/C123/p1710000000000100'
    )
  })

  it('omits Slack current-thread context for non-Slack inbound', async () => {
    const inst = instance({ provider: 'discord' })
    const content = await (inst as any).buildChannelInboxMessage(
      {
        command: 'mention',
        content: 'hello',
        user: { id: 'u1', name: 'User' },
        responseContext: { provider: 'discord', channelId: 'D1' },
      },
      null
    )

    expect(content).toBe('**Discord from User:** "hello"')
    expect(content).not.toContain('Target squad')
    expect(content).not.toContain('Your agent ID')
  })
})

describe('ChannelInstance status command', () => {
  const createdSquadIds: string[] = []

  afterEach(async () => {
    if (createdSquadIds.length === 0) return
    await db.delete(squads).where(inArray(squads.id, createdSquadIds.splice(0)))
  })

  async function createSquad(name: string) {
    const [squad] = await db.insert(squads).values({ name, purpose: 'channel status test' }).returning()
    createdSquadIds.push(squad!.id)
    return squad!
  }

  it('queries the complete scoped active and queued set before the cap and reflects mutations', async () => {
    const target = await createSquad(`status-target-${crypto.randomUUID()}`)
    const other = await createSquad(`status-other-${crypto.randomUUID()}`)
    const activeRows = [
      ...Array.from({ length: 8 }, (_, index) => ({
        squadId: target.id,
        title: `Active ${index}`,
        status: 'active' as const,
        priority: 'normal' as const,
        createdAt: new Date(`2026-01-${String(index + 1).padStart(2, '0')}T00:00:00Z`),
      })),
      {
        squadId: target.id,
        title: 'Critical active',
        status: 'active' as const,
        priority: 'critical' as const,
        createdAt: new Date('2026-01-09T00:00:00Z'),
      },
    ]
    const inserted = await db
      .insert(workStreams)
      .values([
        ...activeRows,
        {
          squadId: target.id,
          title: 'Queued third',
          status: 'queued',
          priority: 'low',
          createdAt: new Date('2026-02-01T00:00:00Z'),
        },
        {
          squadId: target.id,
          title: 'Queued second',
          status: 'queued',
          priority: 'normal',
          createdAt: new Date('2026-02-02T00:00:00Z'),
        },
        {
          squadId: target.id,
          title: 'Queued first',
          status: 'queued',
          priority: 'critical',
          createdAt: new Date('2026-02-03T00:00:00Z'),
        },
      ])
      .returning()
    const firstQueued = inserted.at(-1)!
    await db.insert(workStreams).values({ squadId: other.id, title: 'Unauthorized other squad', status: 'active' })

    const inst = instance({ defaultSquadId: target.id })
    const slackInbound = {
      ...inbound('C1'),
      command: 'status',
      responseContext: { provider: 'slack', channelId: 'C1' },
    } as any
    const discordInbound = {
      ...slackInbound,
      responseContext: { provider: 'discord', channelId: 'C1' },
    } as any

    const slack = await inst.handleSyncCommand(slackInbound)
    const discord = await inst.handleSyncCommand(discordInbound)
    expect(discord).toBe(slack)
    expect(slack).toContain('Active and queued (12)')
    expect(slack).toContain('Queued first')
    expect(slack.indexOf('Critical active')).toBeLessThan(slack.indexOf('Active 0'))
    expect(slack.indexOf('Active 0')).toBeLessThan(slack.indexOf('Active 7'))
    expect(slack).not.toContain('Queued second')
    expect(slack).not.toContain('Unauthorized other squad')
    expect(slack).toContain('2 more not shown')

    await db.update(workStreams).set({ status: 'done' }).where(eq(workStreams.id, firstQueued!.id))
    const mutated = await inst.handleSyncCommand(slackInbound)
    expect(mutated).toContain('Active and queued (11)')
    expect(mutated).toContain('Queued second')
    expect(mutated).not.toContain('Queued first')
    expect(mutated).toContain('1 more not shown')
  })
})
