import { createHash } from 'node:crypto'
import type { ZodType } from 'zod'
import {
  brokerRedeemResponse,
  brokerRefreshResponse,
  brokerRevokeResponse,
  brokerStartResponse,
} from '@ficus/shared/oauth-broker'
import { platformRequest } from '../../platform/instance-client'
import { OAuthTransportError, type OAuthTransport } from './transport'

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex')

export const operationKey = {
  redeem: (localFlowId: string): string => sha256(`redeem:${localFlowId}`),
  refresh: (connectionId: string, materialRevision: string, tokenRevision: number): string =>
    sha256(`refresh:${connectionId}:${materialRevision}:${tokenRevision}`),
  revoke: (credentialRef: string): string => sha256(`revoke:${credentialRef}`),
  connectionFingerprint: (connectionId: string): string => sha256(connectionId),
}

type PlatformRequester = <T>(input: {
  path: string
  body: unknown
  schema: ZodType<T>
  timeoutMs?: number
  signal?: AbortSignal
}) => Promise<T>

export function createBrokerTransport(request: PlatformRequester = platformRequest): OAuthTransport {
  const path = (providerKey: string, operation: string): string => {
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(providerKey)) throw new OAuthTransportError('unsupported_provider')
    return `/api/oauth-broker/${providerKey}/${operation}`
  }

  return {
    authority: 'platform_broker',
    async authorizationUrl(input) {
      const result = await request({
        path: path(input.providerKey, 'start'),
        body: { localFlowId: input.localFlowId, intent: input.intent },
        schema: brokerStartResponse,
      })
      return { authorizationUrl: result.authorizationUrl, expiresAt: result.expiresAt }
    },
    async completeAuthorization(input) {
      if (!input.handle || input.code) throw new OAuthTransportError('malformed_callback')
      const result = await request({
        path: path(input.providerKey, 'redeem'),
        body: {
          handle: input.handle,
          localFlowId: input.localFlowId,
          operationKey: operationKey.redeem(input.localFlowId),
        },
        schema: brokerRedeemResponse,
      })
      return {
        configuration: result.configuration,
        tokens: result.credential,
        displayName: result.displayName,
      }
    },
    async refresh(input) {
      const result = await request({
        path: path(input.providerKey, 'refresh'),
        body: {
          refreshToken: input.refreshToken,
          operationKey: operationKey.refresh(input.connectionId, input.materialRevision, input.tokenRevision),
          connectionFingerprint: operationKey.connectionFingerprint(input.connectionId),
        },
        schema: brokerRefreshResponse,
      })
      return {
        configuration: result.configuration,
        tokens: {
          accessToken: result.accessToken,
          refreshToken: result.refreshToken,
          expiresAt: result.expiresAt,
        },
        displayName: 'OAuth connection',
      }
    },
    async revoke(input) {
      await request({
        path: path(input.providerKey, 'revoke'),
        body: { token: input.token, operationKey: operationKey.revoke(input.credentialRef) },
        schema: brokerRevokeResponse,
      })
    },
  }
}
