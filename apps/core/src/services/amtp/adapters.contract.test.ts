// Runs amtp-engine's contract-test kit (§4.12) against Ficus's real
// drizzle-backed adapters (adapters.ts) and delivery hooks (hooks.ts), using
// the normal apps/core test database (see src/test-setup.ts). This proves the
// two normative behaviors that necessarily leak to hosts: DeliveryHooks
// rollback (§4.10) and allow-rule matching (§4.9), plus general port
// conformance for every other store.
//
// Several suites use identifiers that are opaque to the ENGINE but must be
// real, FK-valid rows in TAU's schema (e.g. `recipientRef: 'agent-1'` is not
// a real agent uuid). Where that happens, this file's `make()` factories wrap
// the real adapter/hook behind a thin translation shim that maps the
// contract kit's synthetic identifiers to real rows created on the fly — the
// logic under test is always Ficus's real adapter, never a fake.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { generateKeyPairSync, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { eq, inArray, sql } from 'drizzle-orm'
import { contractKit } from 'amtp-engine'
import { Agent } from '../../entities/Agent'
import { agentIdentityHostPath, ensureAgentIdentity } from './agent-identity'
import type { AmtpSignedAgentCard } from 'amtp-protocol'
import {
  db,
  agents,
  amtpAllowRules,
  amtpKnownKeys,
  amtpReceived,
  inbox,
  inboxAttachments,
  outbox,
  peers,
} from '../../db'
import { AmtpAllowRule } from '../../entities/AmtpAllowRule'
import { Peer } from '../../entities/Peer'
import { getSettingsStore } from '../settings'
import { sha256Hex, writeAttachmentFile } from '../inbox/attachment-storage'
import {
  attachmentStore,
  handleDirectory,
  outboxStore,
  peerStore,
  pinStore,
  receivePolicy,
  replayLedger,
} from './adapters'
import { deliveryHooks } from './hooks'

const t = { describe, test }

// --- Shared per-test isolation -----------------------------------------------
// The federation-only tables are wholesale-truncated before each test,
// mirroring the established per-file pattern for the outbox table
// (entities/Outbox.test.ts: `beforeEach(() => db.delete(outbox))`). `agents`
// is NOT truncated (too broadly shared with unrelated fixtures/features) —
// agents created by this file are tracked in `createdAgentIds` and deleted by
// id instead, every test, by suites below.

let home: string
const origHomeDir = process.env.HOME_DIR
let createdAgentIds: string[] = []

beforeEach(async () => {
  await db.delete(outbox)
  await db.delete(amtpKnownKeys)
  await db.delete(amtpReceived)
  await db.delete(amtpAllowRules)
  await db.delete(inboxAttachments)
  await db.delete(inbox)
  await db.delete(peers)

  home = await mkdtemp(join(tmpdir(), 'amtp-adapters-contract-'))
  process.env.HOME_DIR = home
  const store = getSettingsStore()
  await store.set('INBOX_MAX_ATTACHMENT_BYTES', '10485760')
  await store.set('INBOX_MAX_TOTAL_STORAGE_BYTES', '10737418240')
})

afterEach(async () => {
  if (origHomeDir === undefined) delete process.env.HOME_DIR
  else process.env.HOME_DIR = origHomeDir
  await rm(home, { recursive: true, force: true })

  if (createdAgentIds.length) {
    await db.delete(agents).where(inArray(agents.id, createdAgentIds))
    createdAgentIds = []
  }
})

async function seedInboxMessage(): Promise<string> {
  const [row] = await db
    .insert(inbox)
    .values({ recipientType: 'user', recipientId: 'user', senderType: 'system', content: 'seed' })
    .returning()
  return row.id
}

/** Minimal raw agent row, mirroring entities/Agent.amtp.test.ts's fixture pattern. */
async function createAgent(fields: { amtpHandle?: string | null; inboundOpen?: boolean } = {}): Promise<string> {
  const id = randomUUID()
  await db.insert(agents).values({
    id,
    agentTypeId: 'manager',
    squadId: null,
    status: 'idle',
    amtpHandle: fields.amtpHandle ?? null,
    identityPublicKey: null,
    inboundOpen: fields.inboundOpen ?? false,
  })
  createdAgentIds.push(id)
  const agent = await Agent.mustFind(id)
  await ensureAgentIdentity(agent, `agent_${id}`)
  return id
}

describe('HandleDirectory durable identity boundary', () => {
  const card: AmtpSignedAgentCard = {
    v: 1,
    instanceId: 'instance',
    handle: 'placeholder',
    card: { name: 'Test' },
    cardSig: 'signature',
  }

  test('resolves and serves a card from a valid durable key when the private PEM is missing', async () => {
    const handle = `durable-${randomUUID()}`
    const id = await createAgent({ amtpHandle: handle, inboundOpen: true })
    await db
      .update(agents)
      .set({ cardJson: { ...card, handle } })
      .where(eq(agents.id, id))
    await rm(agentIdentityHostPath(`agent_${id}`), { force: true })

    expect(await handleDirectory.resolve(handle)).toMatchObject({
      recipientRef: id,
      inboundOpen: true,
      agentPublicKeyPem: expect.stringContaining('BEGIN PUBLIC KEY'),
    })
    expect(await handleDirectory.getCard(handle)).toEqual({ ...card, handle })
  })

  test('keeps dormant handles resolvable and listed for wake-eligible remote correspondence', async () => {
    const handle = `dormant-${randomUUID()}`
    const id = await createAgent({ amtpHandle: handle, inboundOpen: true })
    await db.update(agents).set({ status: 'dormant', dormantAt: new Date() }).where(eq(agents.id, id))

    expect(await handleDirectory.resolve(handle)).toMatchObject({ recipientRef: id, inboundOpen: true })
    expect((await handleDirectory.list()).map((entry) => entry.handle)).toContain(handle)
  })

  test.each([
    ['null', null],
    ['malformed', 'not-a-public-key'],
    [
      'non-Ed25519',
      generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'pem' }) as string,
    ],
  ])('does not resolve or serve cards for a %s durable identity', async (_case, identityPublicKey) => {
    const handle = `invalid-${randomUUID()}`
    const id = await createAgent({ amtpHandle: handle, inboundOpen: true })
    await db
      .update(agents)
      .set({ identityPublicKey, cardJson: { ...card, handle } })
      .where(eq(agents.id, id))

    expect(await handleDirectory.resolve(handle)).toBeNull()
    expect(await handleDirectory.getCard(handle)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// PeerStore (§4.2)
// ---------------------------------------------------------------------------
contractKit.runPeerStoreContract(t, async () => ({
  store: peerStore,
  seed: async (instanceId, peer) => {
    const created = await Peer.create({
      localAlias: instanceId,
      instanceId,
      baseUrl: peer.baseUrl,
      publicKeyPem: peer.publicKeyPem,
    })
    if (peer.status !== created.status) {
      await Peer.update(created.id, { status: peer.status })
    }
  },
}))

// ---------------------------------------------------------------------------
// PinStore (§4.3)
// ---------------------------------------------------------------------------
contractKit.runPinStoreContract(t, async () => pinStore)

// ---------------------------------------------------------------------------
// ReplayLedger (§4.5)
// ---------------------------------------------------------------------------
contractKit.runReplayLedgerContract(t, async () => replayLedger)

// ---------------------------------------------------------------------------
// OutboxStore (§4.6)
// ---------------------------------------------------------------------------
contractKit.runOutboxStoreContract(t, async () => outboxStore)

// ---------------------------------------------------------------------------
// AttachmentStore (§4.7)
// ---------------------------------------------------------------------------
contractKit.runAttachmentStoreContract(t, async () => {
  const idMap = new Map<string, string>()

  return {
    store: {
      totalStoredBytes: () => attachmentStore.totalStoredBytes(),
      readOutboundBlob: (attachmentId: string) =>
        attachmentStore.readOutboundBlob(idMap.get(attachmentId) ?? attachmentId),
    },
    seedBlob: async (attachmentId: string, blob: { bytes: Uint8Array; contentType: string; byteSize: number }) => {
      const messageId = await seedInboxMessage()
      const realId = randomUUID()
      const storagePath = await writeAttachmentFile(messageId, realId, blob.bytes)
      await db.insert(inboxAttachments).values({
        id: realId,
        messageId,
        filename: `${attachmentId}.bin`,
        contentType: blob.contentType,
        byteSize: blob.byteSize,
        sha256: sha256Hex(blob.bytes),
        storagePath,
      })
      idMap.set(attachmentId, realId)
    },
    seedStoredBytes: async (bytes: number) => {
      const messageId = await seedInboxMessage()
      await db.insert(inboxAttachments).values({
        id: randomUUID(),
        messageId,
        filename: 'seed-bytes.bin',
        contentType: 'application/octet-stream',
        byteSize: bytes,
        sha256: 'x'.repeat(64),
        storagePath: '',
      })
    },
  }
})

// ---------------------------------------------------------------------------
// HandleDirectory (§4.8)
// ---------------------------------------------------------------------------
contractKit.runHandleDirectoryContract(t, async () => {
  const handleToToken = new Map<string, string>()
  const handleToAgentId = new Map<string, string>()
  const seededHandles = new Set<string>()

  return {
    directory: {
      resolve: async (handle: string) => {
        const real = await handleDirectory.resolve(handle)
        if (!real) return null
        const testToken = handleToToken.get(handle)
        return {
          recipientRef: testToken ?? real.recipientRef,
          inboundOpen: real.inboundOpen,
          agentPublicKeyPem: real.agentPublicKeyPem,
        }
      },
      // Filtered to this test's own seeded handles so the exact-equality
      // assertion below is insulated from any unrelated agent noise in the
      // shared test database — mirrors routes/amtp.handles.test.ts's
      // established `mine = handles.filter(...)` pattern (there, by a unique
      // prefix; here, by a tracked seed set). This never masks a real
      // exclusion bug: seedTerminated does not remove its handle from
      // `seededHandles`, so an incorrectly-still-listed terminated handle
      // would still surface as a failure.
      list: async () => (await handleDirectory.list()).filter((h) => seededHandles.has(h.handle)),
      getCard: (handle: string) => handleDirectory.getCard(handle),
    },
    seed: async (
      handle: string,
      record: { recipientRef: string; inboundOpen: boolean; agentPublicKeyPem: string | null }
    ) => {
      const id = await createAgent({
        amtpHandle: handle,
        inboundOpen: record.inboundOpen,
      })
      handleToToken.set(handle, record.recipientRef)
      handleToAgentId.set(handle, id)
      const provisioned = await Agent.mustFind(id)
      record.agentPublicKeyPem = provisioned.identityPublicKey
      seededHandles.add(handle)
    },
    seedTerminated: async (handle: string) => {
      const id = handleToAgentId.get(handle)
      if (!id) return
      await db.update(agents).set({ status: 'terminated', terminatedAt: new Date() }).where(eq(agents.id, id))
    },
    seedCard: async (handle: string, signedCard: AmtpSignedAgentCard) => {
      const id = handleToAgentId.get(handle)
      if (!id) return
      await db.update(agents).set({ cardJson: signedCard }).where(eq(agents.id, id))
    },
  }
})

// ---------------------------------------------------------------------------
// ReceivePolicy (§4.9) — the allow-rule-matching leakage target
// ---------------------------------------------------------------------------
contractKit.runReceivePolicyContract(t, async () => {
  const refToAgentId = new Map<string, string>()
  const getAgentId = async (recipientRef: string): Promise<string> => {
    const existing = refToAgentId.get(recipientRef)
    if (existing) return existing
    const id = await createAgent()
    refToAgentId.set(recipientRef, id)
    return id
  }

  return {
    policy: {
      isReceiveAllowed: async (args: { recipientRef: string; peerInstanceId: string; senderHandle: string }) => {
        const targetAgentId = await getAgentId(args.recipientRef)
        return receivePolicy.isReceiveAllowed({ ...args, recipientRef: targetAgentId })
      },
      getReceiveCaps: () => receivePolicy.getReceiveCaps(),
    },
    seed: async (
      recipientRef: string,
      rule: { peerInstanceId: string; principalKind: 'any' | 'handle'; principalValue?: string | null }
    ) => {
      const targetAgentId = await getAgentId(recipientRef)
      await AmtpAllowRule.create({
        targetAgentId,
        peerInstanceId: rule.peerInstanceId,
        principalKind: rule.principalKind,
        principalValue: rule.principalValue ?? null,
      })
    },
  }
})

// ---------------------------------------------------------------------------
// DeliveryHooks (§4.10) — the rollback leakage target
// ---------------------------------------------------------------------------
contractKit.runDeliveryHooksContract(t, async (opts) => {
  const refToAgentId = new Map<string, string>()
  const getAgentId = async (recipientRef: string): Promise<string> => {
    const existing = refToAgentId.get(recipientRef)
    if (existing) return existing
    const id = await createAgent()
    refToAgentId.set(recipientRef, id)
    return id
  }

  return {
    hooks: {
      onMessageReceived: async (args: Parameters<typeof deliveryHooks.onMessageReceived>[0]) => {
        const recipientRef = await getAgentId(args.recipientRef)
        // Force a mid-persist failure exactly after `failAfterAttachments`
        // blobs via the SAME real quota mechanism InboxAttachment.create
        // already enforces in production (INBOX_STORAGE_QUOTA_EXCEEDED) —
        // computed from the actual attachment byte sizes for this call so it
        // works regardless of the kit's fixture sizes.
        if (opts?.failAfterAttachments !== undefined) {
          const capBytes = args.attachments
            .slice(0, opts.failAfterAttachments)
            .reduce((sum, a) => sum + a.bytes.byteLength, 0)
          await getSettingsStore().set('INBOX_MAX_TOTAL_STORAGE_BYTES', String(capBytes))
        }
        await deliveryHooks.onMessageReceived({ ...args, recipientRef })
      },
      onDeliveryFailed: (args: Parameters<typeof deliveryHooks.onDeliveryFailed>[0]) =>
        deliveryHooks.onDeliveryFailed(args),
    },
    probes: {
      hasMessage: async (envelopeId: string) => {
        const rows = await db
          .select({ one: sql<number>`1` })
          .from(inbox)
          .where(sql`${inbox.metadata} -> 'remote' ->> 'envelopeId' = ${envelopeId}`)
          .limit(1)
        return rows.length > 0
      },
      hasAttachmentBlob: async (attachmentId: string) => {
        const rows = await db
          .select({ id: inboxAttachments.id })
          .from(inboxAttachments)
          .where(eq(inboxAttachments.filename, `${attachmentId}.bin`))
          .limit(1)
        return rows.length > 0
      },
    },
  }
})
