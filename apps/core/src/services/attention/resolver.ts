import { DEFAULT_ATTENTION, parseAttention, type Attention, type AttentionKind } from '@ficus/shared'
import { eq, inArray } from 'drizzle-orm'
import { db } from '../../db'
import { squadSubscriptions, workStreamSubscriptions } from '../../db/schema'
import { listUserSquadAttention } from '../squad/subscriptions'
import { listUserWorkStreamAttention } from '../work-streams/subscriptions'

/**
 * Effective attention. Two shapes, deliberately:
 *
 *  - ONE USER, MANY TARGETS (`UserAttention`): a request loads that user's rows once and resolves
 *    precedence in memory for every action/stream it renders.
 *  - ONE TARGET, MANY USERS (`list*NotifyUserIds`): an event loads the rows for that squad and
 *    those streams — a bounded candidate set — and resolves precedence per candidate. Because
 *    DEFAULT_ATTENTION never notifies, a user WITHOUT a row can never be a notify recipient, so
 *    the candidate set is exactly the rows. Never iterate all users here.
 */
export interface UserAttention {
  readonly squads: ReadonlyMap<string, Attention>
  readonly workStreams: ReadonlyMap<string, Attention>
  /** Levels for squad-level items (manager questions, halted agents) or a squadless item. */
  forSquad(squadId: string | null | undefined): Attention
  /** Levels for one stream: its own row, else its squad's row, else the default. */
  forWorkStream(workStreamId: string, squadId: string | null | undefined): Attention
}

export function buildUserAttention(
  squads: ReadonlyMap<string, Attention>,
  workStreams: ReadonlyMap<string, Attention>
): UserAttention {
  const forSquad = (squadId: string | null | undefined): Attention =>
    (squadId ? squads.get(squadId) : undefined) ?? DEFAULT_ATTENTION
  return {
    squads,
    workStreams,
    forSquad,
    forWorkStream: (workStreamId, squadId) => workStreams.get(workStreamId) ?? forSquad(squadId),
  }
}

/** Non-user identities (agent/system/legacy) never had a watch requirement; they carry defaults. */
export const EMPTY_USER_ATTENTION: UserAttention = buildUserAttention(new Map(), new Map())

export async function loadUserAttention(userId: string): Promise<UserAttention> {
  const [squads, workStreams] = await Promise.all([listUserSquadAttention(userId), listUserWorkStreamAttention(userId)])
  return buildUserAttention(squads, workStreams)
}

async function loadSquadRows(squadId: string | null): Promise<Map<string, Attention>> {
  if (!squadId) return new Map()
  const rows = await db
    .select({ userId: squadSubscriptions.userId, attention: squadSubscriptions.attention })
    .from(squadSubscriptions)
    .where(eq(squadSubscriptions.squadId, squadId))
  return new Map(rows.map((row) => [row.userId, parseAttention(row.attention)]))
}

/** streamId -> userId -> levels, for every given stream, in one query. */
async function loadStreamRows(workStreamIds: readonly string[]): Promise<Map<string, Map<string, Attention>>> {
  const byStream = new Map<string, Map<string, Attention>>()
  if (workStreamIds.length === 0) return byStream
  const rows = await db
    .select({
      workStreamId: workStreamSubscriptions.workStreamId,
      userId: workStreamSubscriptions.userId,
      attention: workStreamSubscriptions.attention,
    })
    .from(workStreamSubscriptions)
    .where(inArray(workStreamSubscriptions.workStreamId, [...workStreamIds]))
  for (const row of rows) {
    const forStream = byStream.get(row.workStreamId) ?? new Map<string, Attention>()
    forStream.set(row.userId, parseAttention(row.attention))
    byStream.set(row.workStreamId, forStream)
  }
  return byStream
}

/** Users whose effective `kind` level is `notify` for this one work stream. */
export async function listWorkStreamNotifyUserIds(
  workStreamId: string,
  squadId: string,
  kind: AttentionKind
): Promise<string[]> {
  const [squadRows, streamRows] = await Promise.all([loadSquadRows(squadId), loadStreamRows([workStreamId])])
  const stream = streamRows.get(workStreamId) ?? new Map<string, Attention>()
  const notify: string[] = []
  for (const userId of new Set([...squadRows.keys(), ...stream.keys()])) {
    const effective = stream.get(userId) ?? squadRows.get(userId) ?? DEFAULT_ATTENTION
    if (effective[kind] === 'notify') notify.push(userId)
  }
  return notify
}

/**
 * Users whose effective `kind` level is `notify` for an item that belongs to a squad and may also
 * originate in work streams (an agent question with work-stream origins).
 *
 * ORIGIN PRECEDENCE. With origins, the item IS its origins: each one resolves the normal way
 * (stream row, else squad row, else the default) and any origin at `notify` notifies. Muting a
 * stream therefore silences the questions that come out of it even inside a notified squad — the
 * squad row alone can never add a user back. With no origins the item is the squad's own, so the
 * squad row (else the default) decides.
 */
export async function listSquadScopeNotifyUserIds(
  squadId: string | null,
  workStreamIds: readonly string[],
  kind: AttentionKind
): Promise<string[]> {
  const [squadRows, streamRows] = await Promise.all([loadSquadRows(squadId), loadStreamRows(workStreamIds)])
  const candidates = new Set<string>(squadRows.keys())
  for (const rows of streamRows.values()) for (const userId of rows.keys()) candidates.add(userId)

  const notify: string[] = []
  for (const userId of candidates) {
    const squadLevel = squadRows.get(userId) ?? DEFAULT_ATTENTION
    const notified =
      workStreamIds.length === 0
        ? squadLevel[kind] === 'notify'
        : workStreamIds.some(
            (workStreamId) => (streamRows.get(workStreamId)?.get(userId) ?? squadLevel)[kind] === 'notify'
          )
    if (notified) notify.push(userId)
  }
  return notify
}
