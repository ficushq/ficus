import type { GitHubPersonalIdentityStatus } from '@ficus/shared'
import { db } from '../../../db'
import type { GitHubIdentityRoutesService } from '../../../routes/github-identity'
import type { IntegrationRoutesService } from '../../../routes/integrations'
import type { Identity } from '../../rbac'
import {
  AuthorizationFlowError,
  IntegrationAuthorizationService,
  type AuthorizationServiceDependencies,
} from '../authorization/service'
import { DeviceAuthorizationService, type DeviceAuthorizationDependencies } from '../authorization/device-service'
import {
  resolveStoredGitHubPurpose,
  resumeLocalGitHubIdentity,
  type GitHubAuthorizationSource,
} from './authorization-context'
import { GitHubFeedbackError, requireGitHubHuman } from './feedback-trust'
import {
  beginGitHubIdentityLink,
  confirmGitHubIdentityProof,
  getGitHubPersonalIdentity,
  getPendingGitHubIdentityProof,
  requireGitHubIdentityGeneration,
  unlinkGitHubIdentity,
} from './personal-identity'
import type { GitHubPersonalOAuthFinalizer } from './personal-oauth-finalizer'

type CommonAuthorization = NonNullable<IntegrationRoutesService['authorization']>
type PersonalRequest = { userId: string; identity?: Identity }
interface Dependencies {
  authorization: Omit<AuthorizationServiceDependencies, 'installIdentityGrant'>
  device: Omit<DeviceAuthorizationDependencies, 'installIdentity' | 'verifyPersonal'>
  finalizer: Pick<GitHubPersonalOAuthFinalizer, 'install'>
  configuration(): GitHubPersonalIdentityStatus['authorization']
  initializeIntegrationDefaults(): Promise<void>
}

/**
 * Browser and device orchestration shares the existing coordinators, but constructs the personal
 * finalizer adapters per request. A stored owner ID selects purpose, never proves human authority.
 */
export class GitHubIdentityAuthorization {
  readonly integrationAuthorization: IntegrationAuthorizationService
  readonly integrationDevice: DeviceAuthorizationService
  readonly personal: GitHubIdentityRoutesService
  readonly common: Pick<CommonAuthorization, 'resolvePurpose' | 'callback' | 'complete' | 'pollDevice' | 'cancelDevice'>

  constructor(private readonly dependencies: Dependencies) {
    this.integrationAuthorization = new IntegrationAuthorizationService(dependencies.authorization)
    this.integrationDevice = new DeviceAuthorizationService(dependencies.device)
    this.personal = {
      get: async (identity) => {
        await requireGitHubHuman(db, identity)
        return {
          linked: await getGitHubPersonalIdentity(identity),
          confirmation: await getPendingGitHubIdentityProof(identity),
          authorization: dependencies.configuration(),
        }
      },
      start: async (identity, returnTo) => {
        const userId = await requireGitHubHuman(db, identity)
        const linkGeneration = await beginGitHubIdentityLink(identity)
        const config = dependencies.configuration()
        if (!config.configured) throw new AuthorizationFlowError('broker_unconfigured')
        if (config.authority === 'local' && config.mode === 'device')
          return this.#personalDevice(identity).start({ userId, returnTo, purpose: 'github_identity', linkGeneration })
        return this.#personalAuthorization(identity).start({
          providerKey: 'github',
          userId,
          returnTo,
          intent: { kind: 'connect' },
          purpose: 'github_identity',
          linkGeneration,
        })
      },
      poll: async (identity, id) => {
        const userId = await this.#requirePersonalDevice(identity, id)
        return this.#personalDevice(identity).poll({ id, userId })
      },
      cancel: async (identity, id) => {
        const userId = await this.#requirePersonalDevice(identity, id)
        await this.#personalDevice(identity).cancel({ id, userId })
      },
      confirm: confirmGitHubIdentityProof,
      unlink: unlinkGitHubIdentity,
    }
    this.common = {
      resolvePurpose: resolveStoredGitHubPurpose,
      callback: async (input) => {
        const personal = await this.#isPersonal(input, { kind: 'callback', state: input.state }, input.providerKey)
        if (personal) {
          await this.#requireRequester(input)
          // Recovery may only reuse a staged copy or immutable result, never a consumed code.
          const hasCode = typeof input.code === 'string' && input.code.length >= 1 && input.code.length <= 4096
          if (hasCode === (input.denied === true) || (input.code !== undefined && !hasCode))
            throw new AuthorizationFlowError('malformed_callback')
          const resumed = await resumeLocalGitHubIdentity({
            identity: input.identity,
            nonce: input.state,
            finalizer: dependencies.finalizer,
            receipts: dependencies.device.receipts,
          })
          if (resumed) return resumed
          return this.#personalAuthorization(input.identity).callback(input)
        }
        const result = await this.integrationAuthorization.callback(input)
        await dependencies.initializeIntegrationDefaults()
        return result
      },
      complete: async (input) => {
        if (await this.#isPersonal(input, { kind: 'complete', localFlowId: input.localFlowId }, input.providerKey)) {
          await this.#requireRequester(input)
          return this.#personalAuthorization(input.identity).complete(input)
        }
        const result = await this.integrationAuthorization.complete(input)
        await dependencies.initializeIntegrationDefaults()
        return result
      },
      pollDevice: async (input) => {
        if (await this.#isPersonal(input, { kind: 'device', id: input.id }, 'github')) {
          await this.#requireRequester(input)
          return this.#personalDevice(input.identity).poll(input)
        }
        const result = await this.integrationDevice.poll(input)
        if (result.status === 'complete') await dependencies.initializeIntegrationDefaults()
        return result
      },
      cancelDevice: async (input) => {
        if (await this.#isPersonal(input, { kind: 'device', id: input.id }, 'github')) {
          await this.#requireRequester(input)
          return this.#personalDevice(input.identity).cancel(input)
        }
        await this.integrationDevice.cancel(input)
      },
    }
  }

  #personalAuthorization(identity: Identity | undefined) {
    return new IntegrationAuthorizationService({
      ...this.dependencies.authorization,
      installIdentityGrant: (input) => this.dependencies.finalizer.install({ ...input, identity }),
    })
  }

  #personalDevice(identity: Identity | undefined) {
    return new DeviceAuthorizationService({
      ...this.dependencies.device,
      verifyPersonal: async (record) => {
        if ((await requireGitHubHuman(db, identity)) !== record.userId)
          throw new GitHubFeedbackError('identity_flow_mismatch', 409)
        await requireGitHubIdentityGeneration(identity, record.receipt.linkGeneration!)
      },
      installIdentity: ({ state, userId, credential }) =>
        this.dependencies.finalizer.install({
          identity,
          state,
          userId,
          exchange: async () => ({ configuration: {}, credential, displayName: '' }),
        }),
    })
  }

  async #requireRequester(input: PersonalRequest) {
    if ((await requireGitHubHuman(db, input.identity)) !== input.userId)
      throw new GitHubFeedbackError('identity_flow_mismatch', 409)
  }

  async #isPersonal(input: { userId: string }, source: GitHubAuthorizationSource, providerKey: string) {
    return (await resolveStoredGitHubPurpose({ providerKey, userId: input.userId, source })) === 'github_identity'
  }

  async #requirePersonalDevice(identity: Identity | undefined, id: string) {
    const userId = await requireGitHubHuman(db, identity)
    if (!(await this.#isPersonal({ userId }, { kind: 'device', id }, 'github')))
      throw new GitHubFeedbackError('identity_flow_mismatch', 409)
    return userId
  }
}
