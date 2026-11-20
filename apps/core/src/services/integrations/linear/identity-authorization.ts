import { createHash, randomUUID } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import { LinearOAuthClient } from '@ficus/shared/oauth-providers/linear/client'
import { LINEAR_IDENTITY_ADAPTER_KEY } from '@ficus/shared/oauth-providers/linear/client'
import { db, integrationAuthorizationFlowReceipts, integrationOauthStates, userLinearIdentities } from '../../../db'
import { createLogger } from '../../../lib/infra/logger'
import {
  AuthorizationFlowError,
  BROKER_COMPLETION_HANDLE_PATTERN,
  IntegrationAuthorizationService,
  type AuthorizationServiceDependencies,
} from '../authorization/service'
import type { OAuthAuthorizationPurpose } from '../authorization/state-repository'
import type { OAuthTransport } from '../authorization/transport'

const log = createLogger('linear-identity')

/**
 * Linking a Ficus user's Linear account (design 6.6): a user-actor `read` authorization of the Ficus
 * Linear app, on local and hosted instances alike (the hosted broker serves the `linear-identity`
 * adapter). Ficus records which Linear user and workspace the person is, then discards the token.
 * A linked account lets that person's exact select replies in Linear answer Ficus questions they may
 * answer in Ficus; it never grants anything by itself.
 */

export type LinearIdentitySource = { kind: 'callback'; state: string } | { kind: 'complete'; localFlowId: string }

/** The stored purpose of a Linear flow, from owner-bound state (never a request hint). */
export async function resolveStoredLinearPurpose(input: {
  userId: string
  source: LinearIdentitySource | { kind: 'device'; id: string }
}): Promise<OAuthAuthorizationPurpose | null> {
  const { source } = input
  if (source.kind === 'device') return null
  if (source.kind === 'callback' && !BROKER_COMPLETION_HANDLE_PATTERN.test(source.state)) return null
  if (source.kind === 'complete' && !z.uuid().safeParse(source.localFlowId).success) return null
  const stateHash = source.kind === 'callback' ? createHash('sha256').update(source.state).digest('hex') : null
  const [state] = await db
    .select({ purpose: integrationOauthStates.purpose })
    .from(integrationOauthStates)
    .where(
      and(
        eq(integrationOauthStates.userId, input.userId),
        eq(integrationOauthStates.providerKey, 'linear'),
        source.kind === 'callback'
          ? eq(integrationOauthStates.stateHash, stateHash!)
          : eq(integrationOauthStates.localFlowId, source.localFlowId)
      )
    )
    .limit(1)
  let purpose = state?.purpose
  if (!purpose && source.kind === 'complete') {
    const [receipt] = await db
      .select({ purpose: integrationAuthorizationFlowReceipts.purpose })
      .from(integrationAuthorizationFlowReceipts)
      .where(
        and(
          eq(integrationAuthorizationFlowReceipts.initiatingUserId, input.userId),
          eq(integrationAuthorizationFlowReceipts.providerKey, 'linear'),
          eq(integrationAuthorizationFlowReceipts.localFlowId, source.localFlowId)
        )
      )
      .limit(1)
    purpose = receipt?.purpose
  }
  return purpose === 'linear_identity' || purpose === 'integration' ? purpose : null
}

/** Records the link: one Ficus user per Linear account and one Linear account per user and workspace. */
export async function recordLinearIdentity(input: { userId: string; organizationId: string; linearUserId: string }) {
  await db.transaction(async (tx) => {
    await tx
      .delete(userLinearIdentities)
      .where(
        and(
          eq(userLinearIdentities.organizationId, input.organizationId),
          eq(userLinearIdentities.linearUserId, input.linearUserId)
        )
      )
    await tx
      .delete(userLinearIdentities)
      .where(
        and(
          eq(userLinearIdentities.userId, input.userId),
          eq(userLinearIdentities.organizationId, input.organizationId)
        )
      )
    await tx.insert(userLinearIdentities).values(input)
  })
}

export interface LinearIdentityView {
  linked: Array<{ organizationId: string; linearUserId: string; linkedAt: string }>
}

export class LinearIdentityAuthorization {
  readonly #service: IntegrationAuthorizationService

  constructor(
    private readonly dependencies: {
      authorization: AuthorizationServiceDependencies
      transport: OAuthTransport
      client?: Pick<LinearOAuthClient, 'userIdentity'>
    }
  ) {
    const client = dependencies.client ?? new LinearOAuthClient()
    this.#service = new IntegrationAuthorizationService({
      ...dependencies.authorization,
      installIdentityGrant: async ({ exchange, userId }) => {
        const grant = await exchange()
        const credential = grant.credential as { accessToken?: string }
        if (!credential.accessToken) throw new AuthorizationFlowError('invalid_response')
        let identity
        try {
          identity = await client.userIdentity({ accessToken: credential.accessToken })
        } catch (error) {
          const code = error instanceof Error && /^[a-z_]{1,64}$/.test(error.message) ? error.message : 'provider_error'
          throw new AuthorizationFlowError(code)
        } finally {
          // Ficus keeps no personal token: revoke it at once, best effort.
          await dependencies.transport
            .revoke({
              providerKey: LINEAR_IDENTITY_ADAPTER_KEY,
              credentialRef: `linear-identity:${randomUUID()}`,
              token: credential.accessToken,
            })
            .catch(() => log.info('A linked Linear account token could not be revoked; it expires within a day'))
        }
        await recordLinearIdentity({ userId, ...identity })
      },
    })
  }

  start(input: { userId: string; returnTo: string }) {
    return this.#service.start({
      providerKey: 'linear',
      userId: input.userId,
      returnTo: input.returnTo,
      intent: { kind: 'connect' },
      purpose: 'linear_identity',
    })
  }

  callback(input: { providerKey: string; userId: string; state: string; code?: string; denied?: true }) {
    return this.#service.callback(input)
  }

  complete(input: { providerKey: string; userId: string; localFlowId: string; handle: string }) {
    return this.#service.complete(input)
  }

  async get(userId: string): Promise<LinearIdentityView> {
    const rows = await db.select().from(userLinearIdentities).where(eq(userLinearIdentities.userId, userId))
    return {
      linked: rows.map((row) => ({
        organizationId: row.organizationId,
        linearUserId: row.linearUserId,
        linkedAt: row.linkedAt.toISOString(),
      })),
    }
  }

  async unlink(userId: string, organizationId?: string) {
    const removed = await db
      .delete(userLinearIdentities)
      .where(
        organizationId
          ? and(eq(userLinearIdentities.userId, userId), eq(userLinearIdentities.organizationId, organizationId))
          : eq(userLinearIdentities.userId, userId)
      )
      .returning()
    return removed.length > 0
  }
}
