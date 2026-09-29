import { eq, and, sql, isNull } from 'drizzle-orm'
import { db } from '../db'
import { users, userCredentials, sessions, roleAssignments, agentTokens, emailVerifications } from '../db/schema'
import { invalidatePermissionCache } from '../services/rbac/permissions'
import { grantDefaultRoles } from '../services/rbac/default-roles'
import type { InferSelectModel } from 'drizzle-orm'
import { createHash, randomUUID } from 'crypto'
import { SESSION_TOKEN_PREFIX } from '../services/auth/token-prefixes'

export type UserRow = InferSelectModel<typeof users>

export interface CreateUserInput {
  email: string
  displayName?: string
  /** Skip the roles every new person gets (e.g. a shared account like the demo reviewer). */
  withoutDefaultRoles?: boolean
}

/**
 * A user plus the onboarding facts that tell an *invited* account apart from a
 * *joined* one. An invite creates the user row immediately (routes/users.ts), so
 * the row's existence says nothing about whether the person ever showed up.
 */
export interface UserOnboarding {
  user: User
  /** Passkeys registered to this account. Zero = registration was never completed. */
  passkeyCount: number
  /**
   * Expiry of the newest still-unconsumed registration challenge for this
   * address, or null when there is none. A value in the past means the invite
   * lapsed unused; a future one means it is still redeemable.
   */
  inviteExpiresAt: Date | null
}

/** Either the pooled db handle or a drizzle transaction handle. */
export type UserExecutor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0]

export class User {
  constructor(private row: UserRow) {}

  get id() {
    return this.row.id
  }
  get email() {
    return this.row.email
  }
  get displayName() {
    return this.row.displayName
  }
  get createdAt() {
    return this.row.createdAt
  }
  get updatedAt() {
    return this.row.updatedAt
  }
  get disabledAt() {
    return this.row.disabledAt
  }
  get isDisabled() {
    return this.row.disabledAt !== null
  }

  toJSON() {
    return {
      id: this.id,
      email: this.email,
      displayName: this.displayName,
      disabledAt: this.disabledAt?.toISOString() ?? null,
      createdAt: this.createdAt.toISOString(),
      updatedAt: this.updatedAt.toISOString(),
    }
  }

  /**
   * @param tx optional drizzle transaction handle, so a caller can create the
   * user and its first role assignments as one atomic unit (invites do exactly
   * that — a user that exists with no role is a broken invite).
   */
  static async create(input: CreateUserInput, tx: UserExecutor = db): Promise<User> {
    const [row] = await tx
      .insert(users)
      .values({
        email: input.email,
        displayName: input.displayName ?? null,
      })
      .returning()
    // Every new person gets the default roles (the farm), as ordinary assignments.
    if (!input.withoutDefaultRoles) {
      await grantDefaultRoles([row!.id], undefined, tx)
      invalidatePermissionCache()
    }
    return new User(row)
  }

  static async findById(id: string): Promise<User | null> {
    const [row] = await db.select().from(users).where(eq(users.id, id))
    return row ? new User(row) : null
  }

  static async findByEmail(email: string): Promise<User | null> {
    const [row] = await db.select().from(users).where(eq(users.email, email))
    return row ? new User(row) : null
  }

  /**
   * Case-insensitive lookup. `email_verifications.email` is stored lowercased while
   * `users.email` keeps whatever case it was created with, so anything that resolves
   * a user FROM a verification row (invite tokens, recovery requests) must compare
   * case-insensitively or an invite to `Foo@Bar.com` silently resolves to nobody.
   */
  static async findByEmailInsensitive(email: string): Promise<User | null> {
    const [row] = await db
      .select()
      .from(users)
      .where(sql`lower(${users.email}) = ${email.toLowerCase()}`)
    return row ? new User(row) : null
  }

  static async findAll(): Promise<User[]> {
    const rows = await db.select().from(users)
    return rows.map((r) => new User(r))
  }

  /**
   * Every user plus their onboarding state, in ONE query. The admin Users list
   * renders every account on the instance, so a per-user credential lookup would
   * be a straight N+1; both facts come back as aggregates over left joins.
   */
  static async findAllWithOnboarding(): Promise<UserOnboarding[]> {
    const rows = await db
      .select({
        row: users,
        // count(DISTINCT) is load-bearing: the two left joins multiply each
        // other's rows, so a plain count(credentials.id) would report
        // passkeys × outstanding challenges.
        passkeyCount: sql<string>`count(distinct ${userCredentials.id})`,
        inviteExpiresAt: sql<Date | null>`max(${emailVerifications.expiresAt})`,
      })
      .from(users)
      .leftJoin(userCredentials, eq(userCredentials.userId, users.id))
      .leftJoin(
        emailVerifications,
        and(
          // email_verifications.email is stored lowercased while users.email
          // keeps its original case — see findByEmailInsensitive.
          sql`lower(${emailVerifications.email}) = lower(${users.email})`,
          eq(emailVerifications.purpose, 'register'),
          isNull(emailVerifications.usedAt)
        )
      )
      // Grouping by the primary key lets Postgres functionally-depend every
      // other users column, so the whole row survives the aggregate.
      .groupBy(users.id)

    return rows.map((r) => ({
      user: new User(r.row),
      passkeyCount: Number(r.passkeyCount),
      inviteExpiresAt: r.inviteExpiresAt ? new Date(r.inviteExpiresAt) : null,
    }))
  }

  static async count(): Promise<number> {
    const result = await db.select({ count: sql<number>`count(*)` }).from(users)
    return Number(result[0].count)
  }

  /**
   * Count of enabled (non-`disabledAt`) user accounts — every row in `users`
   * IS a human account (there is no system/service/bot account type in this
   * table), so the only exclusion that makes sense is one already enforced
   * everywhere else a user's standing is checked (auth/pairing.ts,
   * device-tokens.ts, resolve-token.ts, admin-users.ts's `hasAdminUsers`,
   * rbac/permissions.ts): a disabled account can't log in or act, so it isn't
   * an active seat. Used by the platform usage reporter for seat billing.
   */
  static async countActive(): Promise<number> {
    const result = await db
      .select({ count: sql<number>`count(*)` })
      .from(users)
      .where(isNull(users.disabledAt))
    return Number(result[0].count)
  }

  async update(input: { email?: string; displayName?: string | null; disabledAt?: Date | null }): Promise<User> {
    const [row] = await db
      .update(users)
      .set({ ...input, updatedAt: new Date() })
      .where(eq(users.id, this.id))
      .returning()
    this.row = row
    return this
  }

  async disable(): Promise<User> {
    return this.update({ disabledAt: new Date() })
  }

  async enable(): Promise<User> {
    return this.update({ disabledAt: null })
  }

  async delete(): Promise<void> {
    // Revoke any agent tokens this user owns (e.g. system-manager tokens) before
    // deleting. The agent_tokens.user_id FK is ON DELETE SET NULL, which would
    // otherwise silently downgrade the token to a plain agent identity instead
    // of invalidating it; setting revokedAt makes resolveToken fail closed.
    await db
      .update(agentTokens)
      .set({ revokedAt: new Date() })
      .where(and(eq(agentTokens.userId, this.id), isNull(agentTokens.revokedAt)))
    await db
      .delete(roleAssignments)
      .where(and(eq(roleAssignments.subjectType, 'user'), eq(roleAssignments.subjectId, this.id)))
    invalidatePermissionCache()
    await db.delete(users).where(eq(users.id, this.id))
  }

  async createSession(opts?: {
    userAgent?: string
    ipAddress?: string
    expiresInMs?: number
    /** A paired device's embedded web view (a web handoff): the session ends with the device. */
    deviceTokenId?: string | null
  }): Promise<string> {
    const token = `${SESSION_TOKEN_PREFIX}${randomUUID()}`
    const tokenHash = createHash('sha256').update(token).digest('hex')
    const expiresAt = new Date(Date.now() + (opts?.expiresInMs ?? 30 * 24 * 60 * 60 * 1000))

    await db.insert(sessions).values({
      userId: this.id,
      tokenHash,
      userAgent: opts?.userAgent ?? null,
      ipAddress: opts?.ipAddress ?? null,
      expiresAt,
      deviceTokenId: opts?.deviceTokenId ?? null,
    })

    return token
  }

  async getCredentials() {
    return db.select().from(userCredentials).where(eq(userCredentials.userId, this.id))
  }

  async addCredential(input: {
    credentialId: string
    publicKey: string
    counter: number
    transports?: string[]
    displayName?: string
  }) {
    return db
      .insert(userCredentials)
      .values({
        userId: this.id,
        credentialId: input.credentialId,
        publicKey: input.publicKey,
        counter: input.counter,
        transports: input.transports ?? null,
        displayName: input.displayName ?? null,
      })
      .returning()
  }
}
