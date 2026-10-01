import { DependabotDiscoveryError } from './github/dependabot-poller'
import { reportDependabotUnavailable } from './github/dependabot-status'
import { notifyDeliverySnapshotChanged } from './github/delivery-presentation-store'
import { credentialSetupStatus, connectionSetupStatus } from './setup-status'
import {
  pushIntegrationCatalog,
  isPushIntegration,
  getPushIntegrationSettings,
  configurePushIntegration,
  initializePushIntegrationStates,
  setPushIntegrationEnabled,
} from './push/settings'
import {
  openAIServicesIntegrationCatalog,
  initializeOpenAIServicesState,
  getOpenAIServicesSettings,
  configureOpenAIServices,
  setOpenAIServicesEnabled,
} from './openai-services/settings'
import {
  googleCloudIntegrationCatalog,
  initializeGoogleCloudIntegrationState,
  setGoogleCloudIntegrationEnabled,
  getGoogleCloudIntegrationSettings,
  configureGoogleCloudIntegration,
} from './google-cloud/settings'
import {
  deploymentIntegrationCatalog,
  isDeploymentIntegration,
  initializeDeploymentIntegrationStates,
  setDeploymentIntegrationEnabled,
  getDeploymentIntegrationSettings,
  configureDeploymentIntegration,
} from './deployment/settings'
import { importLegacyLinearCredential } from './linear/legacy-import'
import {
  isChannelIntegration,
  getChannelIntegrationSettings,
  configureChannelIntegration,
  initializeChannelIntegrationStates,
  slackAppManifest,
} from './channels/settings'
import { getSettingsStore } from '../settings'
import { configureLinearWebhook, getLinearWebhookSettings } from './linear/webhook-settings'
import { resolveLinearConnection } from './linear/resolve-connection'
import {
  globalIntegrationDefault,
  initializeGitHubDefault,
  reconcileIntegrationSquads,
  reconcileSquadIntegration,
  setGlobalIntegrationDefault,
} from './scope-settings'
import { isIntegrationEnabled, setIntegrationEnabled } from './provider-state'
import { configureGitHubWebhook, getGitHubWebhookSettings } from './github/webhook-settings'
import { publishIntegrationOutputs } from './outputs/runtime'
import { resolveGitHubConnection } from './github/resolve-connection'
import { DeviceAuthorizationService } from './authorization/device-service'
import {
  DbDeviceAuthorizationRepository,
  deleteExpiredDeviceAuthorizations,
} from './authorization/db-device-repository'
import { GitHubOAuthClient } from '@ficus/shared/oauth-providers/github/client'
import { resolveGitHubAppCredentials } from './authorization/github-app'
import { resolveInstanceGitHubConnection } from './github/resolve-connection'
import { checkGitHubRepositoryAccess } from './github/repository-access'
import { parseGitHubConfiguration } from '@ficus/shared/oauth-providers/github/config'
import { integrationOutputRegistry } from './outputs/registry'
import { join } from 'path'
import { getHomeDir } from '../../lib/utils/home'
import { getSecretStore } from '../secrets'
import { IntegrationRegistry } from './registry'
import { resolveOAuthAuthority } from './authorization/authority'
import { firstPartyIntegrationPlugins } from './first-party-plugins'
import { oauthPluginView } from './oauth-plugin-view'
import { channelConnections } from './channels/connections'
import { OAuthConnectionAuthorizer } from './authorization/connection-authorizer'
import { DbIntegrationConnectionRepository } from './db-connection-repository'
import { IntegrationConnectionService } from './connection-service'
import { IntegrationRevalidationWorker } from './revalidation-worker'
import {
  DbIntegrationCredentialCleanupRepository,
  IntegrationCredentialCleanupWorker,
} from './credential-cleanup-worker'
import { ExportConsentService } from './export/consent-service'
import { DbExportConsentRepository } from './export/db-consent-repository'
import { DbIntegrationAuditRecorder } from './db-audit'
import { DbExportOutboxRepository } from './export/db-outbox-repository'
import { ExportOutbox } from './export/outbox'
import { ExportCompletionProjector } from './export/completion-projector'
import { IntegrationExportWorker } from './export/worker'
import { IntegrationExportRuntime } from './export/runtime-worker'
import { resolveExportDelivery, resolveExportDeliveryDecision } from './export/delivery-context'
import { encrypt, decrypt, getEncryptionKey } from '../secrets/crypto'
import { dispatchVerifiedWebhookEvent } from '../webhooks/dispatch'
import { getLastRealWebhookDeliveriesForRepos } from '../webhooks/store'
import { EventPollingRunner } from './event-polling-runner'
import { DbEventPollingCursorStore } from './db-event-polling-cursor-store'
import { DbEventPollingDispatchStore } from './db-event-polling-dispatch-store'
import { GitHubPrWatchPolicy } from './github/watch-policy'
import { listGitHubPrWorkStreamCandidates, listGitHubTriggerSquads } from './github/database-watch-source'
import { expandGitHubRepositories } from './github/repository-enumeration-runtime'
import { extractGitHubDispatchFact, validateGitHubDispatchFact } from './github/dispatch-facts'
import { createLogger } from '../../lib/infra/logger'
import { materializeGitHubDispatch } from '../squad-activity/materialize'
import { eventEmitter } from '../../lib/infra/event-emitter'
import { regenerateEnvFileForSquad } from '../squad/env'
import { GitHubCommitSigning, githubSigningKeysApi } from './github/commit-signing'
import { defaultGitHubConnectionId, githubConnectionIdsForUser } from './github/commit-signing-store'
import { resolveGitHubIdentity } from '../sandbox/github-identity'
import { DbOAuthStateRepository } from './authorization/db-state-repository'
import { DbAuthorizationFlowReceiptRepository } from './authorization/flow-repository'
import { AuthorizationFlowRecoveryWorker } from './authorization/flow-recovery-worker'
import { sendOAuthControlPlaneAlert } from './authorization/oauth-operational-alert'
import {
  IntegrationAuthorizationService,
  AuthorizationFlowError,
  type AuthorizationServiceDependencies,
} from './authorization/service'
import {
  configureOAuthApp,
  getOAuthAppSettings,
  resolveHistoricalLocalOAuthClientCredentials,
  resolveOAuthClientCredentials,
} from './authorization/client-credentials'
import { resolveOAuthCallbackUrl, resolveIntegrationOAuthCallbackUrl } from './authorization/public-url'
import { ConnectionAuthorizationLease } from './authorization/connection-lease'
import { parseOAuthCredential } from './authorization/credential-bundle'
import { DbIntegrationProjectionStateRepository } from './projection/db-state-repository'
import { IntegrationProjectionReconciler, type IntegrationProjectionTarget } from './projection/reconciler'
import { IntegrationProjectionWorker } from './projection/worker'
import { discoverProjectionCredentialDrift } from './projection/credential-drift'
import { IntegrationRefreshService } from './authorization/refresh-service'
import { IntegrationRefreshWorker } from './authorization/refresh-worker'
import { DbIntegrationRevocationRepository, IntegrationRevocationWorker } from './authorization/revocation-worker'
import { createLocalTransport } from './authorization/transport'
import { createBrokerTransport } from './authorization/broker-transport'
import { createRuntimeOAuthTransport } from './authorization/runtime-transport'
import { RevocationArtifactStager } from './authorization/revocation-artifact-stager'
import {
  createBrokerRevocationTransport,
  createLocalRevocationTransport,
  createOAuthRevocationTransportResolver,
} from './authorization/revocation-transport'
import { getSandboxManager, isVmRuntime } from '../sandbox'
import { buildSquadK8sSandboxOptions, resolveLifecycleGenerationForSandbox } from '../sandbox/ensure'
import { Squad } from '../../entities/Squad'
import { ensureSquadWorkspace } from '../squad/workspace'
import { buildAgentProjectionTargets, withLazyProjectionManager } from './runtime-gate'

export function isCurrentExportConsentConnection(
  connection: { id: string } | null,
  requestedConnectionId: string
): boolean {
  return connection?.id === requestedConnectionId
}

export function isCurrentExportConsentAgent(
  agent: { squadId: string | null; parentAgentId: string | null } | null,
  squadId: string
): boolean {
  return Boolean(agent && agent.squadId === squadId && !agent.parentAgentId)
}

const log = createLogger('integration-event-polling')
const oauthLog = createLogger('integration-oauth')

export const integrationConnectionRepository = new DbIntegrationConnectionRepository()

async function reprojectConnection(connectionId: string, providerKey: string) {
  const usage = await integrationConnectionRepository.usage(connectionId)
  for (const squad of usage.squads) {
    await regenerateEnvFileForSquad(squad.id)
    eventEmitter.emit('integration.projection-invalidated', { squadId: squad.id, providerKey })
  }
}

export const githubCommitSigning = new GitHubCommitSigning({
  secrets: {
    get: (key) => getSecretStore().get(key),
    refreshKey: (key) => getSecretStore().refreshKey(key),
    set: (key, value, actor) => getSecretStore().set(key, value, actor),
    delete: (key) => getSecretStore().delete(key),
  },
  keys: githubSigningKeysApi(),
  async account(connectionId) {
    const resolved = await resolveInstanceGitHubConnection(connectionId)
    if (!resolved) return undefined
    const { login, userId } = parseGitHubConfiguration(resolved.connection.configuration)
    return { accessToken: resolved.credential.accessToken, login, userId }
  },
  connectionIdsFor: githubConnectionIdsForUser,
  squadConnectionId: defaultGitHubConnectionId,
  async signerEmails(squadId, connectionId) {
    const emails: string[] = []
    const connection = await integrationConnectionRepository.get(connectionId)
    if (connection) {
      const { login, userId } = parseGitHubConfiguration(connection.configuration)
      emails.push(`${userId}+${login}@users.noreply.github.com`)
    }
    const identity = await resolveGitHubIdentity(squadId)
    if (identity.gitUserEmail) emails.push(identity.gitUserEmail)
    return [...new Set(emails)]
  },
  reproject: (connectionId) => reprojectConnection(connectionId, 'github'),
  keyTitle() {
    let host: string | undefined
    try {
      host = process.env.APP_URL ? new URL(process.env.APP_URL).host : undefined
    } catch {
      host = undefined
    }
    return `Ficus commit signing${host ? ` (${host})` : ''}`
  },
  now: () => new Date(),
})
export const integrationCredentialCleanupWorker = new IntegrationCredentialCleanupWorker(
  new DbIntegrationCredentialCleanupRepository(),
  getSecretStore()
)
export const integrationAuditRecorder = new DbIntegrationAuditRecorder()
export const integrationRegistry = new IntegrationRegistry({
  plugins: firstPartyIntegrationPlugins,
  compatibilityProviders: [],
})
for (const provider of integrationRegistry.providers)
  if (provider.outputs) integrationOutputRegistry.register(provider.outputs)
const oauthTransport = createRuntimeOAuthTransport({
  local: () =>
    createLocalTransport({
      resolveClientCredentials: (providerKey, binding) =>
        resolveOAuthClientCredentials(providerKey, getSecretStore(), binding),
      callbackUrl: resolveOAuthCallbackUrl,
    }),
  broker: () => createBrokerTransport(),
})
const oauthRevocationTransports = createOAuthRevocationTransportResolver({
  local: () =>
    createLocalRevocationTransport({
      resolveClientCredentials: (providerKey, binding) =>
        resolveHistoricalLocalOAuthClientCredentials(providerKey, getSecretStore(), binding),
    }),
  broker: () => createBrokerRevocationTransport(),
})
export const integrationProjectionStateRepository = new DbIntegrationProjectionStateRepository()
export const integrationProjectionReconciler = new IntegrationProjectionReconciler(
  withLazyProjectionManager(
    {
      connections: integrationConnectionRepository,
      // Keep sandbox runtime resolution lazy: this module is imported before the
      // canonical boot guard can report a missing runtime configuration.
      refreshAttached: async (manager, sandboxId, options) => {
        if (isVmRuntime()) await manager.ensureSandbox(sandboxId, options)
      },
      targets: async (squadId) => {
        const squad = await Squad.find(squadId)
        if (!squad) throw new Error('projection_squad_not_found')
        const workspacePath = ensureSquadWorkspace(squadId)
        const targets: IntegrationProjectionTarget[] = [
          { sandboxId: `squad_${squadId}`, options: buildSquadK8sSandboxOptions(squad) },
        ]
        targets.push(
          ...(await buildAgentProjectionTargets({
            agents: await squad.getActiveAgents(),
            resolveLifecycleGeneration: resolveLifecycleGenerationForSandbox,
            optionsForAgent: (agent, sandboxId) => ({
              workspacePath,
              squadId,
              privateVolumePath: join(getHomeDir(), 'private', sandboxId),
              machineId: agent.machineId ?? undefined,
              k8s: { sandboxType: 'agent', alwaysOn: false, privateStorageKey: sandboxId },
            }),
          }))
        )
        return targets
      },
    },
    getSandboxManager
  )
)
let projectionDriftCursor: { squadId: string; providerKey: string } | null = null

export const integrationProjectionWorker = new IntegrationProjectionWorker({
  repository: integrationProjectionStateRepository,
  reconcile: (claim) => integrationProjectionReconciler.reconcile(claim),
  discoverDrift: async (now) => {
    projectionDriftCursor = await discoverProjectionCredentialDrift({
      states: integrationProjectionStateRepository,
      connections: integrationConnectionRepository,
      credential: (reference) => getSecretStore().get(reference),
      now,
      after: projectionDriftCursor,
    })
  },
})
const connectionAuthorizationLease = new ConnectionAuthorizationLease()

export const integrationRefreshService = new IntegrationRefreshService({
  connections: integrationConnectionRepository,
  credentials: {
    get: (key) => getSecretStore().get(key),
    refreshKey: (key) => getSecretStore().refreshKey(key),
    mutateSecret: (key, mutate, actor) => getSecretStore().mutateSecret(key, mutate, actor),
  },
  resolvePlugin: (providerKey) => integrationRegistry.plugin(providerKey),
  transport: oauthTransport,
  lease: connectionAuthorizationLease,
  invalidateAssignments: async (connectionId) => {
    const [connection, usage] = await Promise.all([
      integrationConnectionRepository.get(connectionId),
      integrationConnectionRepository.usage(connectionId),
    ])
    let credentialRevision: bigint | null = null
    if (connection) {
      const raw = getSecretStore().get(connection.credentialRef)
      if (raw) {
        try {
          credentialRevision = BigInt(parseOAuthCredential(raw).tokenRevision)
        } catch {
          // A malformed credential still invalidates and deprojects assignments.
        }
      }
    }
    for (const squad of usage.squads) {
      await integrationProjectionStateRepository.invalidate({
        squadId: squad.id,
        providerKey: connection?.providerKey ?? 'notion',
        credentialRevision,
        now: new Date(),
      })
      await regenerateEnvFileForSquad(squad.id)
      eventEmitter.emit('integration.projection-invalidated', {
        squadId: squad.id,
        providerKey: connection?.providerKey ?? 'notion',
      })
    }
  },
  audit: integrationAuditRecorder,
  operatorAlert: sendOAuthControlPlaneAlert,
  reportOperationalIssue: ({ severity, connectionId, code }) => {
    oauthLog.error('OAuth refresh operational issue', { severity, connectionId, code })
  },
})
export const integrationRefreshWorker = new IntegrationRefreshWorker({
  oauthProviderKeys: () =>
    integrationRegistry
      .plugins()
      .filter((plugin) => plugin.authorization.kind === 'oauth2')
      .map((plugin) => plugin.key),
  listConnections: (providerKey, currentAuthority, afterId, limit, authorityFilter) =>
    integrationConnectionRepository.listRefreshCandidates(
      providerKey,
      currentAuthority,
      afterId,
      limit,
      authorityFilter
    ),
  credentials: { get: (key) => getSecretStore().get(key) },
  currentAuthority: () => resolveOAuthAuthority(),
  refresh: (connectionId, reason) => integrationRefreshService.refresh(connectionId, reason),
})
export const integrationRevocationWorker = new IntegrationRevocationWorker({
  repository: new DbIntegrationRevocationRepository(),
  credentials: {
    get: (key) => getSecretStore().get(key),
    refreshKey: (key) => getSecretStore().refreshKey(key),
  },
  resolvePlugin: (providerKey, adapterVersion, clientAuthority) => {
    const plugin = integrationRegistry.plugin(providerKey)
    if (!plugin || plugin.adapterVersion !== adapterVersion) return undefined
    return oauthPluginView(plugin, clientAuthority)
  },
  revocationTransports: oauthRevocationTransports,
  audit: integrationAuditRecorder,
})
const authorizationFlowReceipts = new DbAuthorizationFlowReceiptRepository()
const oauthStates = new DbOAuthStateRepository()
export const integrationAuthorizationFlowRecoveryWorker = new AuthorizationFlowRecoveryWorker({
  deleteExpired: async () => {
    const count = await oauthStates.deleteExpired()
    await deleteExpiredDeviceAuthorizations()
    return count
  },
})
const installOAuthGrant: AuthorizationServiceDependencies['installGrant'] = async ({
  plugin,
  state,
  exchange,
  userId,
}) => {
  if (plugin.authorization.kind !== 'oauth2' || !plugin.authorization.identity)
    throw new AuthorizationFlowError('grant_installer_unavailable')
  const authorizer = new OAuthConnectionAuthorizer({
    identity: plugin.authorization.identity,
    repository: {
      get: (id) => integrationConnectionRepository.get(id),
      getByAuthorizationFlow: (localFlowId) => integrationConnectionRepository.getByAuthorizationFlow(localFlowId),
      list: (providerKey) => integrationConnectionRepository.list(providerKey),
      installAuthorizedMaterial: (input) => integrationConnectionRepository.installAuthorizedMaterial!(input),
      enqueueRevocation: (input) => integrationConnectionRepository.scheduleRevocation(input),
      ownsRevocation: (input) => integrationConnectionRepository.ownsRevocation(input),
      abandonPendingAuthorization: (input) => integrationConnectionRepository.abandonPendingAuthorization(input),
    },
    flowReceipts: authorizationFlowReceipts,
    stageRevocationArtifact: (input) => new RevocationArtifactStager(getSecretStore()).stage(input),
    connectionService: integrationConnectionService,
    credentials: {
      set: (key, value, actor) => getSecretStore().set(key, value, actor),
      delete: (key) => getSecretStore().delete(key),
    },
    plugin,
    transport: oauthTransport,
    lease: connectionAuthorizationLease,
    reproject: async (connectionId) => {
      const usage = await integrationConnectionRepository.usage(connectionId)
      for (const squad of usage.squads) {
        await regenerateEnvFileForSquad(squad.id)
        eventEmitter.emit('integration.projection-invalidated', {
          squadId: squad.id,
          providerKey: plugin.key,
        })
      }
    },
  })
  await authorizer.install({ intent: state, exchange, userId })
  // Turn commit signing on for the account just connected. Best-effort: the
  // install already committed, and the card offers "Turn on" if this fails.
  if (plugin.key === 'github')
    await githubCommitSigning.enableUndecided(userId).catch((error: Error) => {
      log.warn(`GitHub commit signing setup failed: ${error.message}`)
    })
  // Channel transports read a synchronous snapshot (30s timer refresh otherwise);
  // a managed Slack install should take effect as soon as it lands.
  if (plugin.key === 'slack') await channelConnections.refresh()
}
export const integrationAuthorizationService = new IntegrationAuthorizationService({
  states: oauthStates,
  flowReceipts: authorizationFlowReceipts,
  resolvePlugin: (providerKey) => integrationRegistry.plugin(providerKey),
  transport: oauthTransport,
  callbackUrl: resolveIntegrationOAuthCallbackUrl,
  installGrant: installOAuthGrant,
  audit: integrationAuditRecorder,
})
export const integrationDeviceAuthorizationService = new DeviceAuthorizationService({
  repository: new DbDeviceAuthorizationRepository(),
  receipts: authorizationFlowReceipts,
  client: new GitHubOAuthClient(),
  lease: connectionAuthorizationLease,
  requireLocal() {
    if (resolveOAuthAuthority() !== 'local') throw new AuthorizationFlowError('client_authority_mismatch')
  },
  resolveClient: () => resolveGitHubAppCredentials(getSecretStore())?.clientBinding,
  install: ({ state, userId, grant }) =>
    installOAuthGrant({
      plugin: integrationRegistry.plugin('github')!,
      state,
      userId,
      exchange: async () => grant,
    }),
})
const githubPrWatchPolicy = new GitHubPrWatchPolicy({
  resolveConnection: async (squadId, connectionId) =>
    (await resolveGitHubConnection(squadId, connectionId))?.connection,
  listWorkStreams: listGitHubPrWorkStreamCandidates,
  listSquads: listGitHubTriggerSquads,
  lastRealDeliveries: getLastRealWebhookDeliveriesForRepos,
  expandRepositories: expandGitHubRepositories,
})
const observedPollingSquads = new WeakMap<object, string[]>()
export const integrationEventPollingRuntime = new EventPollingRunner({
  listWatches: () => githubPrWatchPolicy.listWatches(),
  cursorStore: new DbEventPollingCursorStore(),
  onCursorSaved: notifyDeliverySnapshotChanged,
  dispatchStore: new DbEventPollingDispatchStore(),
  resolveCapability: (watch) =>
    integrationRegistry.capability(watch.providerKey, watch.connection.adapterVersion, 'event_polling'),
  observe: async (event, watch) => {
    const handled = await publishIntegrationOutputs(watch.providerKey, event, {
      kind: 'connection',
      connectionId: watch.connection.id,
      squadId: watch.connection.squadId,
    })
    observedPollingSquads.set(event, handled)
  },
  dispatch: (event, watch) =>
    dispatchVerifiedWebhookEvent(watch.providerKey, event, {
      skipOutputs: true,
      handledSquadIds: observedPollingSquads.get(event),
    }),
  extractDispatchFact: extractGitHubDispatchFact,
  validateCompletedDispatch: validateGitHubDispatchFact,
  onCompletedDispatch: async (dispatch, watch) => {
    await materializeGitHubDispatch(dispatch.activityId, watch.connection.squadId)
  },
  onError: (error, watch) => {
    log.error(`Polling failed for ${watch.providerKey}:${watch.resourceKey}`, error)
    if (error instanceof DependabotDiscoveryError)
      void reportDependabotUnavailable(watch.connection.squadId, watch.connection.id).catch(() =>
        log.warn('Could not report Dependabot discovery unavailable')
      )
  },
  // Forty requests per 30-second scan stay below 5,000/hour. Every REST page
  // and optional delivery aggregate request consumes the same bounded budget.
  maxResourcesPerTick: 8,
  maxBudgetUnitsPerTick: 40,
})
export const integrationConnectionService = new IntegrationConnectionService({
  prepareRemoval: async (connection, credential) => {
    if (connection.providerKey !== 'github') return undefined
    // Refresh rotates (and invalidates) the token, possibly in another process: read the latest.
    await getSecretStore()
      .refreshKey(connection.credentialRef)
      .catch(() => {})
    const latest = getSecretStore().get(connection.credentialRef) ?? credential
    let accessToken: string | undefined
    try {
      accessToken = latest ? parseOAuthCredential(latest).accessToken : undefined
    } catch {
      accessToken = undefined
    }
    return githubCommitSigning.prepareRemoval(connection.id, accessToken)
  },
  repository: integrationConnectionRepository,
  assignments: integrationConnectionRepository,
  credentials: {
    get: (key) => getSecretStore().get(key),
    set: (key, value, actor) => getSecretStore().set(key, value, actor),
    delete: (key) => getSecretStore().delete(key),
  },
  resolveProvider: (key, version) => integrationRegistry.require(key, version),
  allowsManualCredential: (key) => integrationRegistry.plugin(key)?.authorization.kind !== 'oauth2',
  currentOAuthAuthority: (key) =>
    integrationRegistry.plugin(key)?.authorization.kind === 'oauth2' ? resolveOAuthAuthority() : undefined,
  operatorAlert: sendOAuthControlPlaneAlert,
  authorizationLease: connectionAuthorizationLease,
  refreshAvailable: (key, raw) => {
    const plugin = integrationRegistry.plugin(key)
    if (!plugin || plugin.authorization.kind !== 'oauth2') return undefined
    if (!raw || !plugin.lifecycle.refresh) return false
    try {
      return parseOAuthCredential(raw).refreshToken !== null
    } catch {
      return false
    }
  },
  refreshAuthenticationFailure: (connectionId) =>
    integrationRefreshService.refresh(connectionId, 'authentication_failure'),
  safeConfiguration: (key, configuration) => {
    const plugin = integrationRegistry.plugin(key)
    return plugin
      ? plugin.connection.safeConfiguration(plugin.connection.parseConfiguration(configuration))
      : configuration
  },
  requiresRemoteRevocation: (key, version, clientAuthority) => {
    const plugin = integrationRegistry.plugin(key)
    if (!plugin || plugin.adapterVersion !== version) return false
    if (plugin.authorization.kind === 'oauth2') return true
    return Boolean(plugin.authorization.managed?.authorities.includes(clientAuthority))
  },
  deproject: async ({ squadIds, providerKey }) => {
    for (const squadId of squadIds) {
      await regenerateEnvFileForSquad(squadId)
      eventEmitter.emit('integration.projection-invalidated', { squadId, providerKey })
    }
  },
  audit: integrationAuditRecorder,
})

export async function initializeIntegrationDefaults() {
  await importLegacyLinearCredential(getSecretStore())
  await initializeChannelIntegrationStates()
  await initializeDeploymentIntegrationStates()
  await initializeGoogleCloudIntegrationState()
  await initializeOpenAIServicesState()
  await initializePushIntegrationStates()
  await initializeGitHubDefault()
  for (const squadId of await reconcileIntegrationSquads('github')) {
    await regenerateEnvFileForSquad(squadId)
    eventEmitter.emit('integration.projection-invalidated', { squadId, providerKey: 'github' })
  }
}

export const integrationRoutesService = Object.assign(integrationConnectionService, {
  catalog: () =>
    Promise.all(
      [
        ...integrationRegistry.catalog(),
        ...deploymentIntegrationCatalog,
        googleCloudIntegrationCatalog,
        ...pushIntegrationCatalog,
        openAIServicesIntegrationCatalog,
      ].map(async (entry) => ({
        ...entry,
        enabled: await isIntegrationEnabled(entry.key),
        setup: isChannelIntegration(entry.key)
          ? (await getChannelIntegrationSettings(entry.key)).setup
          : isDeploymentIntegration(entry.key)
            ? credentialSetupStatus(getDeploymentIntegrationSettings(entry.key).fields)
            : isPushIntegration(entry.key)
              ? credentialSetupStatus(getPushIntegrationSettings(entry.key).fields)
              : entry.key === 'google-cloud'
                ? credentialSetupStatus(getGoogleCloudIntegrationSettings().fields)
                : entry.key === 'openai-services'
                  ? credentialSetupStatus(getOpenAIServicesSettings().fields)
                  : connectionSetupStatus(
                      (await integrationConnectionRepository.list(entry.key)).map((connection) => ({
                        ...connection,
                        credentialConfigured: !!getSecretStore().get(connection.credentialRef)?.trim(),
                      }))
                    ),
      }))
    ),
  async setEnabled(providerKey: string, enabled: boolean, actor: string) {
    if (isPushIntegration(providerKey)) return setPushIntegrationEnabled(providerKey, enabled, actor)
    if (providerKey === 'openai-services') return setOpenAIServicesEnabled(enabled, actor)
    if (providerKey === 'google-cloud') return setGoogleCloudIntegrationEnabled(enabled, actor)
    if (isDeploymentIntegration(providerKey)) return setDeploymentIntegrationEnabled(providerKey, enabled, actor)
    if (isChannelIntegration(providerKey)) {
      await getSettingsStore().set(`__integration-enabled:${providerKey}`, String(enabled), actor)
      return { enabled }
    }
    if (!integrationRegistry.plugin(providerKey)) throw new Error('Unknown integration')
    const squadIds = await setIntegrationEnabled(providerKey, enabled, actor)
    for (const squadId of squadIds) {
      eventEmitter.emit('integration.projection-invalidated', { squadId, providerKey })
      await regenerateEnvFileForSquad(squadId)
    }
    return { enabled }
  },
  refresh: (connectionId: string) => integrationRefreshService.refresh(connectionId, 'explicit'),
  async setDefault(providerKey: string, connectionId: string) {
    await setGlobalIntegrationDefault(providerKey, connectionId)
    for (const squadId of await reconcileIntegrationSquads(providerKey)) {
      await regenerateEnvFileForSquad(squadId)
      eventEmitter.emit('integration.projection-invalidated', { squadId, providerKey })
    }
  },
  async list(providerKey: string) {
    const defaultId = await globalIntegrationDefault(providerKey)
    return Promise.all(
      (await integrationConnectionRepository.list(providerKey)).map(async (row) => ({
        ...(await integrationConnectionService.safeView(row)),
        isGlobalDefault: row.id === defaultId,
      }))
    )
  },
  async get(id: string) {
    const row = await integrationConnectionRepository.get(id)
    return row ? integrationConnectionService.safeView(row) : null
  },
  providerFor: (id: string) => integrationConnectionRepository.providerFor(id),
  githubCommitSigning: (id: string) => githubCommitSigning.status(id),
  setGitHubCommitSigning: (id: string, enabled: boolean, actor: string) =>
    enabled ? githubCommitSigning.enable(id, actor) : githubCommitSigning.disable(id, actor),
  async githubRepositoryAccess(id: string) {
    const resolved = await resolveInstanceGitHubConnection(id)
    if (!resolved) return null
    const configuration = parseGitHubConfiguration(resolved.connection.configuration)
    return checkGitHubRepositoryAccess(resolved.credential.accessToken, configuration.login)
  },
  serviceSettings: {
    get: (provider: string) =>
      isPushIntegration(provider)
        ? getPushIntegrationSettings(provider)
        : provider === 'openai-services'
          ? getOpenAIServicesSettings()
          : getGoogleCloudIntegrationSettings(),
    configure: (provider: string, input: unknown, actor: string) =>
      isPushIntegration(provider)
        ? configurePushIntegration(provider, input, actor)
        : provider === 'openai-services'
          ? configureOpenAIServices(input, actor)
          : configureGoogleCloudIntegration(input, actor),
  },
  deploymentSettings: { get: getDeploymentIntegrationSettings, configure: configureDeploymentIntegration },
  channelSettings: {
    get: getChannelIntegrationSettings,
    configure: configureChannelIntegration,
    manifest: () => slackAppManifest(),
    initializeChannelIntegrationStates,
  },
  linearWebhook: {
    get: () => getLinearWebhookSettings(getSecretStore()),
    configure: (input: unknown, actor: string) => configureLinearWebhook(input, getSecretStore(), actor),
  },
  githubWebhook: {
    get: () => getGitHubWebhookSettings(getSecretStore()),
    configure: (input: unknown, actor: string) => configureGitHubWebhook(input, getSecretStore(), actor),
  },
  oauthApp: {
    get: (providerKey: string) =>
      getOAuthAppSettings(providerKey, getSecretStore(), resolveIntegrationOAuthCallbackUrl(providerKey)),
    configure: (providerKey: string, input: unknown, actor: string) =>
      configureOAuthApp(providerKey, input, getSecretStore(), actor, resolveIntegrationOAuthCallbackUrl(providerKey)),
  },
  authorization: {
    async start(input: { providerKey: string; userId: string; returnTo: string; connectionId?: string }) {
      const connection = input.connectionId ? await integrationConnectionRepository.get(input.connectionId) : null
      if (input.connectionId && (!connection || connection.providerKey !== input.providerKey)) {
        throw new AuthorizationFlowError('invalid_reconnect_target')
      }
      if (
        input.providerKey === 'github' &&
        resolveOAuthAuthority() === 'local' &&
        !resolveGitHubAppCredentials(getSecretStore())?.clientSecret
      ) {
        return integrationDeviceAuthorizationService.start({
          userId: input.userId,
          returnTo: input.returnTo,
          ...(connection ? { connectionId: connection.id, expectedMaterialRevision: connection.materialRevision } : {}),
        })
      }
      return integrationAuthorizationService.start({
        providerKey: input.providerKey,
        userId: input.userId,
        returnTo: input.returnTo,
        intent: connection
          ? {
              kind: 'reconnect',
              connectionId: connection.id,
              expectedMaterialRevision: connection.materialRevision,
            }
          : { kind: 'connect' },
      })
    },
    async pollDevice(input: { id: string; userId: string }) {
      const result = await integrationDeviceAuthorizationService.poll(input)
      if (result.status === 'complete') await initializeIntegrationDefaults()
      return result
    },
    cancelDevice: (input: { id: string; userId: string }) => integrationDeviceAuthorizationService.cancel(input),
    async callback(input: { providerKey: string; userId: string; state: string; code?: string; denied?: true }) {
      const result = await integrationAuthorizationService.callback(input)
      await initializeIntegrationDefaults()
      return result
    },
    async complete(input: { providerKey: string; userId: string; localFlowId: string; handle: string }) {
      const result = await integrationAuthorizationService.complete(input)
      await initializeIntegrationDefaults()
      return result
    },
  },
})

function hasSandboxProjection(providerKey: string): boolean {
  const plugin = integrationRegistry.plugin(providerKey)
  if (!plugin) return false
  const projection = plugin.sandbox
  return [
    projection.packages,
    projection.setupSteps,
    projection.initHooks,
    projection.readiness,
    projection.skills,
    projection.extensions,
    projection.protectedBindings,
  ].some((entries) => entries.length > 0)
}

export const squadIntegrationRoutesService = {
  signGitObject: (squadId: string, agentId: string, payload: Buffer) =>
    githubCommitSigning.sign({ squadId, agentId, payload }),
  async configureScope(squadId: string, providerKey: string, input: { enabled?: boolean; inheritDefault?: boolean }) {
    const scope = await reconcileSquadIntegration(squadId, providerKey, input)
    await regenerateEnvFileForSquad(squadId)
    eventEmitter.emit('integration.projection-invalidated', { squadId, providerKey })
    return scope
  },
  async executionEnvironment(
    squadId: string,
    providerKey: string,
    connectionId?: string
  ): Promise<Record<string, string> | null> {
    if (providerKey === 'linear') {
      const resolved = await resolveLinearConnection(squadId)
      return resolved && (!connectionId || resolved.connection.id === connectionId)
        ? { LINEAR_API_KEY: resolved.credential }
        : null
    }
    if (providerKey !== 'github') return null
    const connection = await resolveGitHubConnection(squadId, connectionId)
    if (!connection) return null
    return {
      GH_TOKEN: connection.credential.accessToken,
      GITHUB_TOKEN: connection.credential.accessToken,
      GITHUB_USER: connection.configuration.login,
    }
  },
  async selection(squadId: string, providerKey: string) {
    const scope = await reconcileSquadIntegration(squadId, providerKey)
    const [assignment, connections, projection, attached] = await Promise.all([
      integrationConnectionRepository.getAssigned(squadId, providerKey),
      integrationConnectionRepository.listPoolSummaries(providerKey),
      integrationProjectionStateRepository.get(squadId, providerKey),
      integrationConnectionRepository.listAssigned(squadId, providerKey),
    ])
    return {
      providerKey,
      scope,
      assignment,
      attached,
      connections,
      ...(hasSandboxProjection(providerKey)
        ? {
            projection:
              assignment?.authState === 'reauthorization_required'
                ? { status: 'reconnect_required' as const, lastErrorCode: assignment.lastErrorCode }
                : assignment?.authState === 'invalid'
                  ? { status: 'degraded' as const, lastErrorCode: assignment.lastErrorCode }
                  : projection
                    ? { status: projection.status, lastErrorCode: projection.lastErrorCode }
                    : null,
          }
        : {}),
    }
  },
  async assign(
    squadId: string,
    providerKey: string,
    connectionId: string,
    actor?: import('./connection-repository').IntegrationAssignmentActor,
    makeDefault = true
  ) {
    const assignment = await integrationConnectionRepository.assign(squadId, providerKey, connectionId, actor, {
      retainPrevious: providerKey === 'github',
      makeDefault: providerKey === 'github' ? makeDefault : true,
    })
    await regenerateEnvFileForSquad(squadId)
    eventEmitter.emit('integration.projection-invalidated', { squadId, providerKey })
    return assignment
  },
  async retryProjection(squadId: string, providerKey: string) {
    const assignment = await integrationConnectionRepository.getAssigned(squadId, providerKey)
    if (!assignment || !hasSandboxProjection(providerKey)) throw new Error('Integration projection unavailable')
    await integrationProjectionStateRepository.invalidate({ squadId, providerKey, now: new Date() })
    eventEmitter.emit('integration.projection-invalidated', { squadId, providerKey })
    return { status: 'pending' as const, lastErrorCode: null }
  },
  async unassign(
    squadId: string,
    providerKey: string,
    actor?: import('./connection-repository').IntegrationAssignmentActor,
    connectionId?: string
  ) {
    const removed = await integrationConnectionRepository.unassign(squadId, providerKey, actor, connectionId)
    if (removed) {
      await regenerateEnvFileForSquad(squadId)
      eventEmitter.emit('integration.projection-invalidated', { squadId, providerKey })
    }
    return removed
  },
}

export const integrationRevalidationWorker = new IntegrationRevalidationWorker(
  integrationConnectionRepository,
  integrationConnectionService
)

export const exportConsentService = new ExportConsentService(
  new DbExportConsentRepository(),
  {
    check: async ({ agentId, squadId, connectionId }) => {
      const [{ Agent }, { AgentType }, connection] = await Promise.all([
        import('../../entities/Agent'),
        import('../../entities/AgentType'),
        integrationConnectionRepository.getAssigned(squadId, 'bigbrain'),
      ])
      const agent = await Agent.find(agentId)
      const agentType = agent ? await AgentType.find(agent.agentTypeId) : null
      const policyAllows =
        agentType?.integrationCapabilities?.version === 1 &&
        agentType.integrationCapabilities.allow.bigbrain?.includes('conversation_export')
      return {
        allowed: Boolean(
          policyAllows &&
          isCurrentExportConsentAgent(agent, squadId) &&
          isCurrentExportConsentConnection(connection, connectionId) &&
          connection?.enabled &&
          connection.authState === 'authenticated' &&
          connection.healthState === 'healthy' &&
          connection.grantedScopes.includes('inbox:write') &&
          connection.validatedRevision === connection.materialRevision &&
          connection.validationExpiresAt &&
          connection.validationExpiresAt > new Date()
        ),
      }
    },
  },
  undefined,
  integrationAuditRecorder
)

const exportOutboxRepository = new DbExportOutboxRepository()
export const integrationExportOutbox = new ExportOutbox(exportOutboxRepository, {
  encrypt: (plaintext) => encrypt(Buffer.from(plaintext).toString('base64'), getEncryptionKey()),
  decrypt: (payload) => Buffer.from(decrypt(payload.encrypted, payload.iv, getEncryptionKey()), 'base64'),
})
export const integrationExportProjector = new ExportCompletionProjector(
  integrationExportOutbox,
  integrationAuditRecorder
)

const integrationExportWorker = new IntegrationExportWorker({
  repository: exportOutboxRepository,
  outbox: integrationExportOutbox,
  recheck: async (batch) => {
    const decision = await resolveExportDeliveryDecision(batch)
    if (!decision.allowed && decision.permanent && decision.context) {
      await integrationAuditRecorder.record({
        connectionId: decision.context.connection.id,
        squadId: decision.context.agent.squadId!,
        agentId: decision.context.agent.id,
        userId: decision.context.consent.consentedByUserId,
        capability: 'conversation_export',
        action: 'cancel',
        outcome: 'denied',
        code: decision.code,
        idempotencyKey: batch.idempotencyKey,
        recordCount: batch.recordCount,
        byteCount: batch.byteCount,
        at: new Date(),
      })
    }
    return decision.allowed
      ? { allowed: true as const }
      : { allowed: false as const, code: decision.code, permanent: decision.permanent }
  },
  deliver: async (batch, payload) => {
    const context = await resolveExportDelivery(batch)
    if (!context) return { ok: false, code: 'runtime_gate_denied', gated: true, permanent: false }
    const credential = getSecretStore().get(context.connection.credentialRef)
    if (!credential) return { ok: false, code: 'credential_unavailable', gated: true, permanent: false }
    try {
      const exportDriver = integrationRegistry.plugin('bigbrain')?.runtime.conversationExport
      if (!exportDriver) return { ok: false, code: 'provider_unavailable', gated: true, permanent: true }
      await exportDriver.send({
        payload,
        connection: {
          id: context.connection.id,
          squadId: context.agent.squadId!,
          providerKey: context.connection.providerKey,
          adapterVersion: context.connection.adapterVersion,
          configuration: context.connection.configuration as { version: 1; apiBase: string },
        },
        credential,
        agentId: context.agent.id,
        squadId: context.agent.squadId!,
        streamId: batch.idempotencyKey,
        fromLine: 1,
      })
      await integrationAuditRecorder.record({
        connectionId: context.connection.id,
        squadId: context.agent.squadId!,
        agentId: context.agent.id,
        capability: 'conversation_export',
        action: 'deliver',
        outcome: 'succeeded',
        idempotencyKey: batch.idempotencyKey,
        recordCount: batch.recordCount,
        byteCount: batch.byteCount,
        at: new Date(),
      })
      return { ok: true }
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? String(error.code) : 'provider_error'
      if (code === 'invalid_auth') {
        await integrationConnectionRepository.disableRuntimeAuthFailure({
          id: context.connection.id,
          materialRevision: context.connection.materialRevision,
        })
      }
      await integrationAuditRecorder.record({
        connectionId: context.connection.id,
        squadId: context.agent.squadId!,
        agentId: context.agent.id,
        capability: 'conversation_export',
        action: 'deliver',
        outcome: 'failed',
        idempotencyKey: batch.idempotencyKey,
        recordCount: batch.recordCount,
        byteCount: batch.byteCount,
        code,
        at: new Date(),
      })
      return { ok: false, code, retryable: !['invalid_auth', 'missing_scope'].includes(code) }
    }
  },
})
export const integrationExportRuntime = new IntegrationExportRuntime(
  integrationExportWorker,
  integrationExportProjector
)
