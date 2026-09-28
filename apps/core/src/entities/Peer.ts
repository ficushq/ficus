import { eq } from 'drizzle-orm'
import type { InferSelectModel } from 'drizzle-orm'
import { db } from '../db'
import { peers } from '../db/schema'
import type { PeerResponse } from '@ficus/shared'

export type PeerRow = InferSelectModel<typeof peers>

export interface CreatePeerInput {
  localAlias: string
  instanceId: string
  baseUrl: string
  publicKeyPem: string
}

export interface PeerResolver {
  resolve(instanceId: string): Promise<{ baseUrl: string; publicKeyPem: string; status: string } | null>
}

export class Peer {
  id!: string
  localAlias!: string
  instanceId!: string
  baseUrl!: string
  publicKeyPem!: string
  status!: string
  createdAt!: Date

  constructor(row: PeerRow) {
    Object.assign(this, row)
  }

  toJson(): PeerResponse {
    return {
      id: this.id,
      localAlias: this.localAlias,
      instanceId: this.instanceId,
      baseUrl: this.baseUrl,
      publicKeyPem: this.publicKeyPem,
      status: this.status,
      createdAt: this.createdAt,
    }
  }

  static async create(input: CreatePeerInput): Promise<Peer> {
    const [row] = await db.insert(peers).values(input).returning()
    return new Peer(row)
  }

  static async list(): Promise<Peer[]> {
    const rows = await db.select().from(peers).orderBy(peers.createdAt)
    return rows.map((r) => new Peer(r))
  }

  static async findById(id: string): Promise<Peer | null> {
    const [row] = await db.select().from(peers).where(eq(peers.id, id)).limit(1)
    return row ? new Peer(row) : null
  }

  static async findByInstanceId(instanceId: string): Promise<Peer | null> {
    const [row] = await db.select().from(peers).where(eq(peers.instanceId, instanceId)).limit(1)
    return row ? new Peer(row) : null
  }

  static async findByLocalAlias(alias: string): Promise<Peer | null> {
    const [row] = await db.select().from(peers).where(eq(peers.localAlias, alias)).limit(1)
    return row ? new Peer(row) : null
  }

  static async update(
    id: string,
    patch: Partial<{ localAlias: string; baseUrl: string; publicKeyPem: string; status: string }>
  ): Promise<Peer | null> {
    const [row] = await db.update(peers).set(patch).where(eq(peers.id, id)).returning()
    return row ? new Peer(row) : null
  }

  static async delete(id: string): Promise<void> {
    await db.delete(peers).where(eq(peers.id, id))
  }
}

export class LocalPeerResolver implements PeerResolver {
  async resolve(instanceId: string) {
    const peer = await Peer.findByInstanceId(instanceId)
    if (!peer) return null
    return { baseUrl: peer.baseUrl, publicKeyPem: peer.publicKeyPem, status: peer.status }
  }
}
