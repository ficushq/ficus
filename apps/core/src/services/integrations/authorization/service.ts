import { createHash, randomBytes as cryptoRandomBytes, randomUUID as cryptoRandomUUID } from 'node:crypto'
import { getOAuthProviderAdapter } from '@ficus/shared/oauth-providers'
import type { IntegrationAuditRecorder } from '../audit'
import type { AuthorizationGrant, IntegrationPluginV1 } from '../plugin'
import type { OAuthStateRecord, OAuthStateRepository } from './state-repository'
import type { AuthorizationFlowReceiptRepository } from './flow-repository'
import { OAuthTransportError, type OAuthTransport } from './transport'
import { PlatformRequestError } from '../../platform/instance-client'
import { BrokerUnconfiguredError } from './authority'
import { oauthPluginView, type OAuthPluginView } from '../oauth-plugin-view'

const STATE_TTL_MS = 10 * 60 * 1_000
export const BROKER_COMPLETION_HANDLE_PATTERN = /^[A-Za-z0-9_-]{43}$/
const STATE_PATTERN = BROKER_COMPLETION_HANDLE_PATTERN
const SAFE_CODE_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/
const hasControlCharacter = (value: string) =>
  [...value].some((character) => character.charCodeAt(0) <= 31 || character.charCodeAt(0) === 127)

type RegisteredPlugin = IntegrationPluginV1<any, any, any>

export class AuthorizationFlowError extends Error {
  constructor(readonly code: string) {
    super(`Integration authorization failed: ${code}`)
    this.name = 'AuthorizationFlowError'
  }
}

export interface AuthorizationServiceDependencies {
  states: OAuthStateRepository
  flowReceipts?: Pick<AuthorizationFlowReceiptRepository, 'getRecoverable' | 'markTerminal'>
  resolvePlugin(providerKey: string): RegisteredPlugin | undefined
  transport: OAuthTransport
  callbackUrl(providerKey?: string): string
  installGrant(input: {
    plugin: RegisteredPlugin
    state: OAuthStateRecord
    exchange: () => Promise<AuthorizationGrant<unknown, unknown>>
    userId: string
  }): Promise<void>
  audit?: IntegrationAuditRecorder
  randomBytes?: (size: number) => Uint8Array
  uuid?: () => string
  now?: () => Date
}

export class IntegrationAuthorizationService {
  readonly #dependencies: AuthorizationServiceDependencies
  readonly #randomBytes: (size: number) => Uint8Array
  readonly #uuid: () => string
  readonly #now: () => Date

  constructor(dependencies: AuthorizationServiceDependencies) {
    this.#dependencies = dependencies
    this.#randomBytes = dependencies.randomBytes ?? cryptoRandomBytes
    this.#uuid = dependencies.uuid ?? cryptoRandomUUID
    this.#now = dependencies.now ?? (() => new Date())
  }

  async start(input: {
    providerKey: string
    userId: string
    returnTo: string
    intent: { kind: 'connect' } | { kind: 'reconnect'; connectionId: string; expectedMaterialRevision: string }
  }): Promise<{ authorizationUrl: string }> {
    const plugin = this.#requireOAuthPlugin(input.providerKey)
    if (!isSafeReturnTarget(input.returnTo)) throw new AuthorizationFlowError('unsafe_return_target')
    try {
      this.#dependencies.transport.requireConfigured?.(plugin.authorization.adapter)
    } catch (error) {
      if (error instanceof OAuthTransportError && error.code === 'oauth_app_unconfigured') {
        throw new AuthorizationFlowError(error.code)
      }
      throw new AuthorizationFlowError('authorization_url_failed')
    }
    const redirectUri = this.#dependencies.callbackUrl(plugin.key)
    const localState = Buffer.from(this.#randomBytes(32)).toString('base64url')
    if (!STATE_PATTERN.test(localState)) throw new AuthorizationFlowError('state_generation_failed')
    const localFlowId = this.#dependencies.transport.authority === 'platform_broker' ? this.#uuid() : localState
    const now = this.#now()
    await this.#dependencies.states.create({
      stateHash: hashState(localFlowId),
      localFlowId: this.#dependencies.transport.authority === 'platform_broker' ? localFlowId : null,
      authority: this.#dependencies.transport.authority,
      providerKey: plugin.key,
      userId: input.userId,
      intent: input.intent.kind,
      connectionId: input.intent.kind === 'reconnect' ? input.intent.connectionId : null,
      expectedMaterialRevision: input.intent.kind === 'reconnect' ? input.intent.expectedMaterialRevision : null,
      redirectUri,
      returnTo: input.returnTo,
      expiresAt: new Date(now.getTime() + STATE_TTL_MS),
    })
    let authorizationUrl: URL
    try {
      const result = await this.#dependencies.transport.authorizationUrl({
        providerKey: plugin.authorization.adapter,
        localFlowId,
        intent: input.intent.kind,
        returnTo: input.returnTo,
        redirectUri,
      })
      authorizationUrl = new URL(result.authorizationUrl)
    } catch (error) {
      if (error instanceof BrokerUnconfiguredError) throw new AuthorizationFlowError(error.code)
      if (error instanceof OAuthTransportError && error.code === 'oauth_app_unconfigured') {
        throw new AuthorizationFlowError(error.code)
      }
      throw new AuthorizationFlowError('authorization_url_failed')
    }
    if (
      !['http:', 'https:'].includes(authorizationUrl.protocol) ||
      authorizationUrl.username ||
      authorizationUrl.password ||
      (this.#dependencies.transport.authority === 'local' &&
        authorizationUrl.searchParams.get('state') !== localState) ||
      (this.#dependencies.transport.authority === 'platform_broker' &&
        (authorizationUrl.protocol !== 'https:' ||
          !isAdapterAuthorizationHost(plugin.authorization.adapter, authorizationUrl)))
    ) {
      throw new AuthorizationFlowError('authorization_url_failed')
    }
    await this.#audit(input.userId, input.providerKey, 'start', 'succeeded')
    return { authorizationUrl: authorizationUrl.toString() }
  }

  async callback(input: {
    providerKey: string
    userId: string
    state: string
    code?: string
    denied?: true
  }): Promise<{ returnTo: string }> {
    const plugin = this.#requireOAuthPlugin(input.providerKey)
    if (!STATE_PATTERN.test(input.state)) throw new AuthorizationFlowError('malformed_state')
    const state = await this.#dependencies.states.consume({
      stateHash: hashState(input.state),
      providerKey: input.providerKey,
      userId: input.userId,
    })
    if (!state) {
      await this.#audit(input.userId, input.providerKey, 'callback', 'denied', 'invalid_or_expired_state')
      throw new AuthorizationFlowError('invalid_or_expired_state')
    }

    const hasCode = typeof input.code === 'string' && input.code.length >= 1 && input.code.length <= 4_096
    const hasDenial = input.denied === true
    if (hasCode === hasDenial || (input.code !== undefined && !hasCode)) {
      await this.#audit(input.userId, input.providerKey, 'callback', 'denied', 'malformed_callback')
      throw new AuthorizationFlowError('malformed_callback')
    }
    if (hasDenial) {
      await this.#audit(input.userId, input.providerKey, 'callback', 'denied', 'provider_denied')
      throw new AuthorizationFlowError('provider_denied')
    }

    const exchange = async (): Promise<AuthorizationGrant<unknown, unknown>> => {
      try {
        const grant = await this.#dependencies.transport.completeAuthorization({
          providerKey: plugin.authorization.adapter,
          localFlowId: input.state,
          code: input.code!,
          redirectUri: state.redirectUri,
        })
        return {
          configuration: grant.configuration,
          credential: {
            version: 1,
            ...grant.tokens,
            tokenRevision: 1,
            ...(grant.clientBinding ? { clientBinding: grant.clientBinding } : {}),
          },
          displayName: grant.displayName,
        }
      } catch (error) {
        const classified = error instanceof OAuthTransportError ? { code: error.code } : plugin.classifyError(error)
        const code = SAFE_CODE_PATTERN.test(classified.code) ? classified.code : 'provider_error'
        throw new AuthorizationFlowError(code)
      }
    }
    try {
      await this.#dependencies.installGrant({ plugin, state, exchange, userId: input.userId })
    } catch (error) {
      const code = error instanceof AuthorizationFlowError ? error.code : 'grant_persistence_failed'
      await this.#audit(input.userId, input.providerKey, 'callback', 'failed', code)
      throw new AuthorizationFlowError(code)
    }
    await this.#audit(input.userId, input.providerKey, 'callback', 'succeeded')
    return { returnTo: state.returnTo }
  }

  async complete(input: {
    providerKey: string
    userId: string
    localFlowId: string
    handle: string
  }): Promise<{ returnTo: string }> {
    if (!BROKER_COMPLETION_HANDLE_PATTERN.test(input.handle)) {
      throw new AuthorizationFlowError('invalid_completion_handle')
    }
    const handleHash = hashState(input.handle)
    const prior = await this.#dependencies.flowReceipts?.getRecoverable(input.localFlowId)
    const receiptMatches =
      prior?.providerKey === input.providerKey &&
      prior.initiatingUserId === input.userId &&
      prior.completionHandleHash === handleHash
    // An installed receipt is the immutable result authority. Deployment-mode
    // changes and coordinator cleanup cannot invalidate an already committed
    // result or turn its replay into a lifecycle mutation.
    if (receiptMatches && prior?.installKind) return { returnTo: prior.returnTo }

    const plugin = this.#requireOAuthPlugin(input.providerKey)
    if (receiptMatches && prior) {
      if (prior.authority !== this.#dependencies.transport.authority) {
        throw new AuthorizationFlowError('client_authority_mismatch')
      }
      if (prior.terminalCode) {
        try {
          const burned = await this.#dependencies.states.burnByFlow({ localFlowId: input.localFlowId, handleHash })
          if (!burned && (await this.#dependencies.states.flowExists(input.localFlowId))) {
            throw new AuthorizationFlowError('invalid_or_expired_state')
          }
        } catch (error) {
          if (error instanceof AuthorizationFlowError) throw error
          throw new AuthorizationFlowError('flow_finalization_failed')
        }
        throw new AuthorizationFlowError(prior.terminalCode)
      }
    }
    const state = await this.#dependencies.states.claimByFlow({
      localFlowId: input.localFlowId,
      providerKey: input.providerKey,
      userId: input.userId,
      authority: 'platform_broker',
      handleHash,
    })
    if (!state) {
      await this.#audit(input.userId, input.providerKey, 'complete', 'denied', 'invalid_or_expired_state')
      throw new AuthorizationFlowError('invalid_or_expired_state')
    }
    if (state.authority !== 'platform_broker' || state.authority !== this.#dependencies.transport.authority) {
      await this.#audit(input.userId, input.providerKey, 'complete', 'failed', 'client_authority_mismatch')
      throw new AuthorizationFlowError('client_authority_mismatch')
    }

    const exchange = async (): Promise<AuthorizationGrant<unknown, unknown>> => {
      try {
        const grant = await this.#dependencies.transport.completeAuthorization({
          providerKey: plugin.authorization.adapter,
          localFlowId: input.localFlowId,
          handle: input.handle,
        })
        return {
          configuration: grant.configuration,
          credential: { version: 1, ...grant.tokens, tokenRevision: 1 },
          displayName: grant.displayName,
        }
      } catch (error) {
        const classified =
          error instanceof PlatformRequestError ||
          error instanceof OAuthTransportError ||
          error instanceof BrokerUnconfiguredError
            ? { code: error.code }
            : plugin.classifyError(error)
        throw new AuthorizationFlowError(SAFE_CODE_PATTERN.test(classified.code) ? classified.code : 'provider_error')
      }
    }

    try {
      await this.#dependencies.installGrant({ plugin, state, exchange, userId: input.userId })
    } catch (error) {
      const code = authorizationErrorCode(error, 'grant_persistence_failed')
      if (burnsCompletionFlow(code)) {
        try {
          if (this.#dependencies.flowReceipts) {
            const terminal = await this.#dependencies.flowReceipts.markTerminal(input.localFlowId, code)
            if (!terminal?.terminalAt) throw new Error('Authorization flow terminal disposition failed')
          }
          await this.#dependencies.states.burnByFlow({ localFlowId: input.localFlowId, handleHash })
        } catch {
          await this.#audit(input.userId, input.providerKey, 'complete', 'failed', 'flow_finalization_failed')
          throw new AuthorizationFlowError('flow_finalization_failed')
        }
      }
      await this.#audit(input.userId, input.providerKey, 'complete', 'failed', code)
      throw new AuthorizationFlowError(code)
    }
    try {
      await this.#dependencies.states.finishByFlow({ localFlowId: input.localFlowId, handleHash })
    } catch {
      await this.#audit(input.userId, input.providerKey, 'complete', 'failed', 'flow_finalization_failed')
      throw new AuthorizationFlowError('flow_finalization_failed')
    }
    await this.#audit(input.userId, input.providerKey, 'complete', 'succeeded')
    return { returnTo: state.returnTo }
  }

  #requireOAuthPlugin(providerKey: string): OAuthPluginView<unknown> {
    const plugin = this.#dependencies.resolvePlugin(providerKey)
    const view = plugin && oauthPluginView(plugin, this.#dependencies.transport.authority)
    if (!view) throw new AuthorizationFlowError('unsupported_provider')
    return view
  }

  async #audit(
    userId: string,
    providerKey: string,
    phase: 'start' | 'callback' | 'complete',
    outcome: 'succeeded' | 'failed' | 'denied',
    code?: string
  ): Promise<void> {
    await this.#dependencies.audit?.record({
      userId,
      action: `authorization_${phase}_${providerKey}`,
      outcome,
      ...(code ? { code } : {}),
      at: this.#now(),
    })
  }
}

function hashState(state: string): string {
  return createHash('sha256').update(state).digest('hex')
}

function authorizationErrorCode(error: unknown, fallback: string): string {
  if (error instanceof AuthorizationFlowError) return error.code
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: unknown }).code
    if (typeof code === 'string' && SAFE_CODE_PATTERN.test(code)) return code
  }
  return fallback
}

function burnsCompletionFlow(code: string): boolean {
  return (
    code === 'completion_not_found' ||
    code === 'invalid_grant' ||
    code === 'operation_key_conflict' ||
    code === 'grant_abandoned' ||
    code === 'flow_expired'
  )
}

function isAdapterAuthorizationHost(adapterKey: string, url: URL): boolean {
  const adapter = getOAuthProviderAdapter(adapterKey)
  return Boolean(adapter?.authorizeHosts.includes(url.host))
}

export function isSafeReturnTarget(value: string): boolean {
  if (
    value.length < 1 ||
    value.length > 1_024 ||
    !value.startsWith('/') ||
    value.startsWith('//') ||
    value.includes('\\') ||
    value.includes('?') ||
    value.includes('#')
  ) {
    return false
  }
  try {
    return !hasControlCharacter(decodeURIComponent(value))
  } catch {
    return false
  }
}
