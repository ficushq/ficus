import { z } from 'zod'

export const OAUTH_BROKER_SCOPES = [
  'integrations.oauth:start',
  'integrations.oauth:redeem',
  'integrations.oauth:refresh',
  'integrations.oauth:revoke',
] as const

export type OAuthBrokerScope = (typeof OAUTH_BROKER_SCOPES)[number]

export const SAFE_CODE_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/

const token = z.string().min(1).max(16_384)
const operationKey = z.string().min(1).max(200)
const localFlowId = z.string().uuid()
const tenantId = z.string().uuid().optional()
const expiresAt = z.string().datetime({ offset: true, precision: 3 }).nullable()
const authorizationUrl = z.string().url().refine(isSafeHttpsUrl, 'credential-free HTTPS URL required')

const providerCredential = z
  .object({
    accessToken: token,
    refreshToken: token.nullable(),
    expiresAt,
  })
  .strict()

export const brokerStartRequest = z
  .object({
    localFlowId,
    intent: z.enum(['connect', 'reconnect']),
    tenantId,
  })
  .strict()

export const brokerCallbackQuery = z
  .object({
    state: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    code: token.optional(),
    error: z.string().min(1).max(512).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.code === undefined) === (value.error === undefined)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'exactly one provider outcome is required' })
    }
  })

export const brokerFailureResponse = z.object({ code: z.string().regex(SAFE_CODE_PATTERN) }).strict()

export const brokerStartResponse = z
  .object({
    authorizationUrl,
    transactionId: z.string().uuid(),
    expiresAt: z.string().datetime({ offset: true }),
  })
  .strict()

export const brokerRedeemRequest = z
  .object({
    handle: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    localFlowId,
    operationKey,
    tenantId,
  })
  .strict()

export const brokerRedeemResponse = z
  .object({
    configuration: z.unknown().optional(),
    credential: providerCredential,
    displayName: z.string().min(1).max(200),
  })
  .strict()
  .refine((value) => Object.hasOwn(value, 'configuration'), { message: 'configuration is required' })

export const brokerRefreshRequest = z
  .object({
    refreshToken: token,
    operationKey,
    connectionFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
    tenantId,
  })
  .strict()

export const brokerRefreshResponse = z
  .object({
    accessToken: token,
    refreshToken: token.nullable(),
    expiresAt,
    configuration: z.unknown().optional(),
  })
  .strict()
  .refine((value) => Object.hasOwn(value, 'configuration'), { message: 'configuration is required' })

export const brokerRevokeRequest = z
  .object({
    token,
    operationKey,
    tenantId,
  })
  .strict()

export const brokerRevokeResponse = z.object({ revoked: z.literal(true) }).strict()

export type BrokerStartRequest = z.infer<typeof brokerStartRequest>
export type BrokerCallbackQuery = z.infer<typeof brokerCallbackQuery>
export type BrokerFailureResponse = z.infer<typeof brokerFailureResponse>
export type BrokerStartResponse = z.infer<typeof brokerStartResponse>
export type BrokerRedeemRequest = z.infer<typeof brokerRedeemRequest>
export interface BrokerRedeemResponse {
  configuration: unknown
  credential: z.infer<typeof providerCredential>
  displayName: string
}
export type BrokerRefreshRequest = z.infer<typeof brokerRefreshRequest>
export interface BrokerRefreshResponse {
  accessToken: string
  refreshToken: string | null
  expiresAt: string | null
  configuration: unknown
}
export type BrokerRevokeRequest = z.infer<typeof brokerRevokeRequest>
export type BrokerRevokeResponse = z.infer<typeof brokerRevokeResponse>

function isSafeHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password
  } catch {
    return false
  }
}
