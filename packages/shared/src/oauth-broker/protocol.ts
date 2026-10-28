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
const localFlowId = z.uuid()
const tenantId = z.uuid().optional()
const expiresAt = z.iso.datetime({ offset: true, precision: 3 }).nullable()
const authorizationUrl = z.url().refine(isSafeHttpsUrl, 'credential-free HTTPS URL required')

const providerCredential = z.strictObject({
  accessToken: token,
  refreshToken: token.nullable(),
  expiresAt,
})

export const brokerStartRequest = z.strictObject({
  localFlowId,
  intent: z.enum(['connect', 'reconnect']),
  tenantId,
})

export const brokerCallbackQuery = z
  .strictObject({
    state: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    code: token.optional(),
    error: z.string().min(1).max(512).optional(),
  })
  .superRefine((value, context) => {
    if ((value.code === undefined) === (value.error === undefined)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'exactly one provider outcome is required' })
    }
  })

export const brokerFailureResponse = z.strictObject({ code: z.string().regex(SAFE_CODE_PATTERN) })

export const brokerStartResponse = z.strictObject({
  authorizationUrl,
  transactionId: z.uuid(),
  expiresAt: z.iso.datetime({ offset: true }),
})

export const brokerRedeemRequest = z.strictObject({
  handle: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  localFlowId,
  operationKey,
  tenantId,
})

export const brokerRedeemResponse = z
  .strictObject({
    configuration: z.unknown().optional(),
    credential: providerCredential,
    displayName: z.string().min(1).max(200),
  })
  .refine((value) => Object.hasOwn(value, 'configuration'), { message: 'configuration is required' })

export const brokerRefreshRequest = z.strictObject({
  refreshToken: token,
  operationKey,
  connectionFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  tenantId,
})

export const brokerRefreshResponse = z
  .strictObject({
    accessToken: token,
    refreshToken: token.nullable(),
    expiresAt,
    configuration: z.unknown().optional(),
  })
  .refine((value) => Object.hasOwn(value, 'configuration'), { message: 'configuration is required' })

export const brokerRevokeRequest = z.strictObject({
  token,
  operationKey,
  tenantId,
})

export const brokerRevokeResponse = z.strictObject({ revoked: z.literal(true) })

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
