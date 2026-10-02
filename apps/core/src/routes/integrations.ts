import { resolveDefaultGitHubIdentity } from '../services/sandbox/github-identity'
import { isDeploymentIntegration } from '../services/integrations/deployment/settings'
import { isChannelIntegration, type ChannelSettingsView } from '../services/integrations/channels/settings'
import type { getDeploymentIntegrationSettings } from '../services/integrations/deployment/settings'
import type { GitHubWebhookSettings } from '../services/integrations/github/webhook-settings'
import { integrationOutputRegistry } from '../services/integrations/outputs/registry'
import { Hono, type Context } from 'hono'
import { db } from '../db'
import { GitHubFeedbackError, requireGitHubHuman } from '../services/integrations/github/feedback-trust'
import type { OAuthAuthorizationPurpose } from '../services/integrations/authorization/state-repository'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { requireSquadPermission } from '../middleware'
// Every squad route below is guarded, so the handler acts on the id the guard resolved and
// authorized rather than the raw param, which may be a short prefix naming a different scope.
import { resolvedSquadId } from '../middleware/require-permission'
import { auditActor, hasPermission, type Identity } from '../services/rbac'
import {
  IntegrationConnectionInUseError,
  IntegrationManualCredentialNotAllowedError,
  type IntegrationConnectionService,
  type SafeIntegrationConnection,
} from '../services/integrations/connection-service'
import type {
  IntegrationAssignmentActor,
  IntegrationConnectionSummary,
} from '../services/integrations/connection-repository'
import {
  AuthorizationFlowError,
  BROKER_COMPLETION_HANDLE_PATTERN,
} from '../services/integrations/authorization/service'
import type { SafeOAuthAppSettings } from '../services/integrations/authorization/client-credentials'
import { describeGitHubAuthorizationError } from '../services/integrations/authorization/github-errors'
import { GitHubOAuthError } from '@ficus/shared/oauth-providers/github/client'
import { createLogger } from '../lib/infra/logger'
import { userSessionRequired } from '../services/auth/user-session-required'
import { GitHubSignRefused, GitHubSigningError } from '../services/integrations/github/commit-signing'
import { MAX_SIGNING_PAYLOAD_BYTES } from '../services/integrations/github/signing-payload'
import type { SafeIntegrationCatalogEntry } from '../services/integrations/plugin'
import type {
  IntegrationAuthorizationStart,
  IntegrationDeviceAuthorizationStatus,
  GitHubCommitSigningStatus,
  GitHubRepositoryAccess,
} from '@ficus/shared'

const log = createLogger('integration-routes')

const providerKeySchema = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/)
const createSchema = z
  .object({
    provider: providerKeySchema,
    displayName: z.string().trim().min(1).max(200),
    configuration: z.unknown(),
    credential: z.string().min(1).max(16_384),
  })
  .strict()
const confirmationSchema = z.object({ confirmAssigned: z.boolean().optional() }).strict()
const credentialSchema = z
  .object({ credential: z.string().min(1).max(16_384), confirmAssigned: z.boolean().optional() })
  .strict()
const assignmentSchema = z.object({ connectionId: z.string().uuid(), makeDefault: z.boolean().optional() }).strict()
const authorizationStartSchema = z
  .object({ returnTo: z.string().min(1).max(1_024), connectionId: z.string().uuid().optional() })
  .strict()
const authorizationCallbackSchema = z
  .object({
    state: z.string().min(1).max(256),
    code: z.string().min(1).max(4_096).optional(),
    denied: z.literal(true).optional(),
  })
  .strict()
const authorizationCompleteSchema = z
  .object({
    localFlowId: z.string().uuid(),
    handle: z.string().regex(BROKER_COMPLETION_HANDLE_PATTERN),
  })
  .strict()

export interface IntegrationRoutesService extends Pick<
  IntegrationConnectionService,
  'create' | 'validate' | 'enable' | 'disable' | 'replaceCredential' | 'remove'
> {
  serviceSettings?: {
    get(provider: string): ReturnType<typeof getDeploymentIntegrationSettings>
    configure(
      provider: string,
      input: unknown,
      actor: string
    ): Promise<ReturnType<typeof getDeploymentIntegrationSettings>>
  }
  deploymentSettings?: {
    get(provider: string): ReturnType<typeof getDeploymentIntegrationSettings>
    configure(
      provider: string,
      input: unknown,
      actor: string
    ): Promise<ReturnType<typeof getDeploymentIntegrationSettings>>
  }
  channelSettings?: {
    get(provider: string): Promise<ChannelSettingsView>
    configure(provider: string, input: unknown, actor: string): Promise<ChannelSettingsView>
    /** The Slack app manifest with this instance's URLs filled in. */
    manifest?(): string
  }
  setDefault?(providerKey: string, connectionId: string): Promise<void>
  catalog?(): readonly SafeIntegrationCatalogEntry[] | Promise<readonly SafeIntegrationCatalogEntry[]>
  setEnabled?(providerKey: string, enabled: boolean, actor: string): Promise<{ enabled: boolean }>
  list(providerKey: string): Promise<readonly SafeIntegrationConnection[]>
  get(id: string): Promise<SafeIntegrationConnection | null>
  providerFor(id: string): Promise<string | null>
  refresh?(connectionId: string): Promise<unknown>
  githubRepositoryAccess?(connectionId: string): Promise<GitHubRepositoryAccess | null>
  githubCommitSigning?(connectionId: string): Promise<GitHubCommitSigningStatus>
  setGitHubCommitSigning?(connectionId: string, enabled: boolean, actor: string): Promise<GitHubCommitSigningStatus>
  linearWebhook?: {
    get(): GitHubWebhookSettings
    configure(input: unknown, actor: string): Promise<GitHubWebhookSettings>
  }
  githubWebhook?: {
    get(): GitHubWebhookSettings
    configure(input: unknown, actor: string): Promise<GitHubWebhookSettings>
  }
  oauthApp?: {
    get(providerKey: string): SafeOAuthAppSettings
    configure(providerKey: string, input: unknown, actor: string): Promise<SafeOAuthAppSettings>
  }
  authorization?: {
    /** Purpose is resolved from owner/provider-bound storage, never request hints. */
    resolvePurpose?(input: {
      providerKey: string
      userId: string
      source: { kind: 'callback'; state: string } | { kind: 'complete'; localFlowId: string }
    }): Promise<OAuthAuthorizationPurpose | null>
    start(input: {
      providerKey: string
      userId: string
      returnTo: string
      connectionId?: string
    }): Promise<IntegrationAuthorizationStart>
    pollDevice?(input: { id: string; userId: string }): Promise<IntegrationDeviceAuthorizationStatus>
    cancelDevice?(input: { id: string; userId: string }): Promise<void>
    callback(input: {
      providerKey: string
      userId: string
      state: string
      code?: string
      denied?: true
      identity?: Identity
    }): Promise<{ returnTo: string }>
    complete(input: {
      providerKey: string
      userId: string
      localFlowId: string
      handle: string
      identity?: Identity
    }): Promise<{ returnTo: string }>
  }
}

export interface SquadIntegrationRoutesService {
  /** Sign a git commit or tag object with the squad's GitHub signing key (agents only). */
  signGitObject?(squadId: string, agentId: string, payload: Buffer): Promise<string>
  configureScope?(
    squadId: string,
    providerKey: string,
    input: { enabled?: boolean; inheritDefault?: boolean }
  ): Promise<unknown>
  executionEnvironment?(
    squadId: string,
    providerKey: string,
    connectionId?: string
  ): Promise<Record<string, string> | null>
  selection(
    squadId: string,
    providerKey: string
  ): Promise<{
    providerKey: string
    scope?: { enabled: boolean; inheritDefault: boolean; globalDefaultId: string | null }
    assignment: IntegrationConnectionSummary | null
    attached?: readonly (IntegrationConnectionSummary & { isDefault: boolean })[]
    connections: readonly IntegrationConnectionSummary[]
    projection?: {
      status: 'pending' | 'installing' | 'ready' | 'degraded' | 'reconnect_required'
      lastErrorCode: string | null
    } | null
  }>
  assign(
    squadId: string,
    providerKey: string,
    connectionId: string,
    actor?: IntegrationAssignmentActor,
    makeDefault?: boolean
  ): Promise<IntegrationConnectionSummary>
  unassign(
    squadId: string,
    providerKey: string,
    actor?: IntegrationAssignmentActor,
    connectionId?: string
  ): Promise<boolean>
  retryProjection(squadId: string, providerKey: string): Promise<{ status: 'pending'; lastErrorCode: null }>
}

/** Select the permission family before callback side effects, preserving literal requester identity. */
async function completionAccess(
  c: Context,
  service: IntegrationRoutesService,
  provider: string,
  source: { kind: 'callback'; state: string } | { kind: 'complete'; localFlowId: string }
): Promise<Response | { identity: Extract<Identity, { type: 'user' }>; personal: boolean }> {
  const identity = c.get('identity') as Identity | undefined
  if (identity?.type !== 'user') {
    const denied = await authorize(c, `integrations:write:${provider}`)
    return denied ?? (await userSessionRequired(c, identity, `connect ${integrationLabel(provider)}`))
  }
  if (provider === 'github' && service.authorization?.resolvePurpose) {
    try {
      await requireGitHubHuman(db, identity)
      if (
        (await service.authorization.resolvePurpose({ providerKey: provider, userId: identity.userId, source })) ===
        'github_identity'
      ) {
        c.set('authzChecked', true)
        return { identity, personal: true }
      }
    } catch (error) {
      if (error instanceof GitHubFeedbackError)
        return c.json({ error: 'Enabled human session required', code: error.code }, 403)
      return authorizationFailure(c, error, provider, source.kind)
    }
  }
  const denied = await authorize(c, `integrations:write:${provider}`)
  return denied ?? { identity, personal: false }
}

export function createIntegrationsRouter(service: IntegrationRoutesService): Hono {
  return new Hono()
    .get('/outputs', async (c) => {
      if (!c.get('identity')) return c.json({ error: 'Unauthorized' }, 401)
      c.set('authzChecked', true)
      return c.json(integrationOutputRegistry.catalog())
    })
    .get('/catalog', async (c) => {
      const identity = c.get('identity') as Identity | undefined
      if (!identity) return c.json({ error: 'Unauthorized' }, 401)
      c.set('authzChecked', true)
      const integrations = await Promise.all(
        ((await service.catalog?.()) ?? []).map(async (entry) => {
          if (await hasPermission(identity, `integrations:read:${entry.key}`)) return entry
          const { setup: _setup, ...publicEntry } = entry
          return publicEntry
        })
      )
      return c.json({ integrations })
    })
    .put('/providers/:provider/enabled', zValidator('json', z.object({ enabled: z.boolean() }).strict()), async (c) => {
      const provider = c.req.param('provider')
      if (!providerKeySchema.safeParse(provider).success) return c.json({ error: 'Invalid provider' }, 400)
      const denied = await authorize(c, `integrations:write:${provider}`)
      if (denied) return denied
      if (!service.setEnabled || !(await service.catalog?.())?.some((entry) => entry.key === provider))
        return c.json({ error: 'Unknown integration' }, 404)
      const identity = c.get('identity') as Identity
      return c.json(await service.setEnabled(provider, c.req.valid('json').enabled, auditActor(identity)))
    })
    .get('/providers/:provider/service-settings', async (c) => {
      const provider = c.req.param('provider')
      const denied = await authorize(c, `integrations:read:${provider}`)
      if (denied) return denied
      if (!['google-cloud', 'openai-services', 'apple-push', 'web-push'].includes(provider) || !service.serviceSettings)
        return c.json({ error: 'Unknown integration' }, 404)
      c.header('Cache-Control', 'no-store')
      return c.json(service.serviceSettings.get(provider))
    })
    .put(
      '/providers/:provider/service-settings',
      zValidator('json', z.record(z.string(), z.string().max(16384).nullable())),
      async (c) => {
        const provider = c.req.param('provider')
        const denied = await authorize(c, `integrations:write:${provider}`)
        if (denied) return denied
        if (
          !['google-cloud', 'openai-services', 'apple-push', 'web-push'].includes(provider) ||
          !service.serviceSettings
        )
          return c.json({ error: 'Unknown integration' }, 404)
        try {
          return c.json(
            await service.serviceSettings.configure(
              provider,
              c.req.valid('json'),
              auditActor(c.get('identity') as Identity)
            )
          )
        } catch {
          return c.json({ error: 'Could not save service credentials. Check the fields and try again.' }, 400)
        }
      }
    )
    .get('/providers/:provider/deployment-settings', async (c) => {
      const provider = c.req.param('provider')
      const denied = await authorize(c, `integrations:read:${provider}`)
      if (denied) return denied
      if (!isDeploymentIntegration(provider) || !service.deploymentSettings)
        return c.json({ error: 'Unknown integration' }, 404)
      c.header('Cache-Control', 'no-store')
      return c.json(service.deploymentSettings.get(provider))
    })
    .put(
      '/providers/:provider/deployment-settings',
      zValidator('json', z.record(z.string(), z.string().max(16384).nullable())),
      async (c) => {
        const provider = c.req.param('provider')
        const denied = await authorize(c, `integrations:write:${provider}`)
        if (denied) return denied
        if (!isDeploymentIntegration(provider) || !service.deploymentSettings)
          return c.json({ error: 'Unknown integration' }, 404)
        try {
          return c.json(
            await service.deploymentSettings.configure(
              provider,
              c.req.valid('json'),
              auditActor(c.get('identity') as Identity)
            )
          )
        } catch {
          return c.json({ error: 'Could not save deployment credentials. Check the fields and try again.' }, 400)
        }
      }
    )
    .get('/providers/:provider/channel-settings', async (c) => {
      const provider = c.req.param('provider')
      const denied = await authorize(c, `integrations:read:${provider}`)
      if (denied) return denied
      if (!isChannelIntegration(provider) || !service.channelSettings)
        return c.json({ error: 'Unknown integration' }, 404)
      c.header('Cache-Control', 'no-store')
      return c.json(await service.channelSettings.get(provider))
    })
    .get('/providers/slack/channel-settings/manifest', async (c) => {
      const denied = await authorize(c, 'integrations:read:slack')
      if (denied) return denied
      if (!service.channelSettings?.manifest) return c.json({ error: 'Unknown integration' }, 404)
      c.header('Cache-Control', 'no-store')
      c.header('Content-Type', 'application/yaml; charset=utf-8')
      c.header('Content-Disposition', 'attachment; filename="ficus-slack-app-manifest.yaml"')
      return c.body(service.channelSettings.manifest())
    })
    .put(
      '/providers/:provider/channel-settings',
      zValidator('json', z.record(z.string(), z.string().max(16384).nullable())),
      async (c) => {
        const provider = c.req.param('provider')
        const denied = await authorize(c, `integrations:write:${provider}`)
        if (denied) return denied
        if (!isChannelIntegration(provider) || !service.channelSettings)
          return c.json({ error: 'Unknown integration' }, 404)
        try {
          return c.json(
            await service.channelSettings.configure(
              provider,
              c.req.valid('json'),
              auditActor(c.get('identity') as Identity)
            )
          )
        } catch {
          return c.json({ error: 'Could not save channel credentials. Check the fields and try again.' }, 400)
        }
      }
    )
    .get('/providers/linear/webhook', async (c) => {
      const denied = await authorize(c, 'integrations:read:linear')
      if (denied) return denied
      if (!service.linearWebhook) return c.json({ error: 'Webhook configuration unavailable' }, 404)
      return c.json(service.linearWebhook.get())
    })
    .put('/providers/linear/webhook', async (c) => {
      const denied = await authorize(c, 'integrations:write:linear')
      if (denied) return denied
      const identity = c.get('identity') as Identity | undefined
      if (identity?.type !== 'user') return userSessionRequired(c, identity, 'configure Linear webhooks')
      if (!service.linearWebhook) return c.json({ error: 'Webhook configuration unavailable' }, 404)
      try {
        return c.json(await service.linearWebhook.configure(await c.req.json(), `user:${identity.userId}`))
      } catch {
        return c.json({ error: 'Webhook configuration failed' }, 400)
      }
    })
    .get('/providers/github/webhook', async (c) => {
      const denied = await authorize(c, 'integrations:read:github')
      if (denied) return denied
      if (!service.githubWebhook) return c.json({ error: 'Webhook configuration unavailable' }, 404)
      return c.json(service.githubWebhook.get())
    })
    .put('/providers/github/webhook', async (c) => {
      const denied = await authorize(c, 'integrations:write:github')
      if (denied) return denied
      const identity = c.get('identity') as Identity | undefined
      if (identity?.type !== 'user') return userSessionRequired(c, identity, 'configure GitHub webhooks')
      if (!service.githubWebhook) return c.json({ error: 'Webhook configuration unavailable' }, 404)
      try {
        return c.json(await service.githubWebhook.configure(await c.req.json(), `user:${identity.userId}`))
      } catch {
        return c.json({ error: 'Webhook configuration failed' }, 400)
      }
    })
    .get('/providers/:provider/oauth-app', async (c) => {
      const providerKey = parseProviderParam(c.req.param('provider'))
      if (!providerKey) return c.json({ error: 'Invalid provider' }, 400)
      const denied = await authorize(c, `integrations:read:${providerKey}`)
      if (denied) return denied
      if (!service.oauthApp) return c.json({ error: 'OAuth application unavailable' }, 404)
      return c.json(service.oauthApp.get(providerKey))
    })
    .put('/providers/:provider/oauth-app', async (c) => {
      const providerKey = parseProviderParam(c.req.param('provider'))
      if (!providerKey) return c.json({ error: 'Invalid provider' }, 400)
      const denied = await authorize(c, `integrations:write:${providerKey}`)
      if (denied) return denied
      const identity = c.get('identity') as Identity | undefined
      if (identity?.type !== 'user')
        return userSessionRequired(c, identity, `configure the ${integrationLabel(providerKey)} app`)
      if (!service.oauthApp) return c.json({ error: 'OAuth application unavailable' }, 404)
      try {
        if (service.oauthApp.get(providerKey).authority === 'platform_broker') {
          return c.json({ error: 'OAuth application configuration failed' }, 400)
        }
        return c.json(await service.oauthApp.configure(providerKey, await c.req.json(), `user:${identity.userId}`))
      } catch {
        return c.json({ error: 'OAuth application configuration failed' }, 400)
      }
    })
    .post('/providers/:provider/authorization/start', zValidator('json', authorizationStartSchema), async (c) => {
      const providerKey = parseProviderParam(c.req.param('provider'))
      if (!providerKey) return c.json({ error: 'Invalid provider' }, 400)
      const denied = await authorize(c, `integrations:write:${providerKey}`)
      if (denied) return denied
      const identity = c.get('identity') as Identity | undefined
      if (identity?.type !== 'user') return userSessionRequired(c, identity, `connect ${integrationLabel(providerKey)}`)
      if (!service.authorization) return c.json({ error: 'Authorization unavailable' }, 503)
      const body = c.req.valid('json')
      try {
        return c.json(
          await service.authorization.start({
            providerKey,
            userId: identity.userId,
            returnTo: body.returnTo,
            connectionId: body.connectionId,
          })
        )
      } catch (error) {
        return authorizationFailure(c, error, providerKey, 'start')
      }
    })
    .post('/providers/github/authorization/device/:id/poll', async (c) => {
      const denied = await authorize(c, 'integrations:write:github')
      if (denied) return denied
      const identity = c.get('identity') as Identity | undefined
      if (identity?.type !== 'user') return userSessionRequired(c, identity, 'connect GitHub')
      const id = z.string().uuid().safeParse(c.req.param('id'))
      if (!id.success) return c.json({ error: 'Invalid authorization' }, 400)
      if (!service.authorization?.pollDevice) return c.json({ error: 'Authorization unavailable' }, 503)
      try {
        return c.json(await service.authorization.pollDevice({ id: id.data, userId: identity.userId }))
      } catch (error) {
        return authorizationFailure(c, error, 'github', 'poll')
      }
    })
    .post('/providers/github/authorization/device/:id/cancel', async (c) => {
      const denied = await authorize(c, 'integrations:write:github')
      if (denied) return denied
      const identity = c.get('identity') as Identity | undefined
      if (identity?.type !== 'user') return userSessionRequired(c, identity, 'connect GitHub')
      const id = z.string().uuid().safeParse(c.req.param('id'))
      if (!id.success) return c.json({ error: 'Invalid authorization' }, 400)
      if (!service.authorization?.cancelDevice) return c.json({ error: 'Authorization unavailable' }, 503)
      try {
        await service.authorization.cancelDevice({ id: id.data, userId: identity.userId })
        return c.json({ canceled: true })
      } catch (error) {
        return authorizationFailure(c, error, 'github', 'cancel')
      }
    })
    .post('/providers/:provider/authorization/callback', zValidator('json', authorizationCallbackSchema), async (c) => {
      const providerKey = parseProviderParam(c.req.param('provider'))
      if (!providerKey) return c.json({ error: 'Invalid provider' }, 400)
      const body = c.req.valid('json')
      const access = await completionAccess(c, service, providerKey, { kind: 'callback', state: body.state })
      if (access instanceof Response) return access
      if (!service.authorization) return c.json({ error: 'Authorization unavailable' }, 503)
      try {
        return c.json(
          await service.authorization.callback({
            providerKey,
            userId: access.identity.userId,
            ...(access.personal ? { identity: access.identity } : {}),
            state: body.state,
            code: body.code,
            denied: body.denied,
          })
        )
      } catch (error) {
        return authorizationFailure(c, error, providerKey, 'callback')
      }
    })
    .post('/providers/:provider/authorization/complete', zValidator('json', authorizationCompleteSchema), async (c) => {
      const providerKey = parseProviderParam(c.req.param('provider'))
      if (!providerKey) return c.json({ error: 'Invalid provider' }, 400)
      const body = c.req.valid('json')
      const access = await completionAccess(c, service, providerKey, {
        kind: 'complete',
        localFlowId: body.localFlowId,
      })
      if (access instanceof Response) return access
      if (!service.authorization) return c.json({ error: 'Authorization unavailable' }, 503)
      try {
        return c.json(
          await service.authorization.complete({
            providerKey,
            userId: access.identity.userId,
            ...(access.personal ? { identity: access.identity } : {}),
            localFlowId: body.localFlowId,
            handle: body.handle,
          })
        )
      } catch (error) {
        return authorizationFailure(c, error, providerKey, 'complete')
      }
    })
    .get('/connections/:connectionId/github-repository-access', async (c) => {
      const denied = await authorize(c, 'integrations:read:github')
      if (denied) return denied
      const id = c.req.param('connectionId')
      c.header('Cache-Control', 'no-store')
      if ((await service.providerFor(id)) !== 'github') return c.json({ error: 'GitHub connection not found' }, 404)
      const result = await service.githubRepositoryAccess?.(id)
      return result ? c.json(result) : c.json({ error: 'Repository access check unavailable' }, 503)
    })
    .get('/connections/:connectionId/github-commit-signing', async (c) => {
      const denied = await authorize(c, 'integrations:read:github')
      if (denied) return denied
      const id = c.req.param('connectionId')
      c.header('Cache-Control', 'no-store')
      if ((await service.providerFor(id)) !== 'github' || !service.githubCommitSigning)
        return c.json({ error: 'GitHub connection not found' }, 404)
      return c.json(await service.githubCommitSigning(id))
    })
    .post(
      '/connections/:connectionId/github-commit-signing',
      zValidator('json', z.object({ enabled: z.boolean() }).strict()),
      async (c) => {
        const denied = await authorize(c, 'integrations:write:github')
        if (denied) return denied
        const identity = c.get('identity')
        // Registers or removes a key on the person's own GitHub account.
        if (identity?.type !== 'user') return userSessionRequired(c, identity, 'change GitHub commit signing')
        const id = c.req.param('connectionId')
        if ((await service.providerFor(id)) !== 'github' || !service.setGitHubCommitSigning)
          return c.json({ error: 'GitHub connection not found' }, 404)
        try {
          return c.json(await service.setGitHubCommitSigning(id, c.req.valid('json').enabled, identityActor(identity)))
        } catch (error) {
          if (error instanceof GitHubSigningError)
            return c.json({ error: error.message, code: error.code }, error.code === 'github_unavailable' ? 502 : 409)
          throw error
        }
      }
    )
    .get('/connections', async (c) => {
      const parsed = providerKeySchema.safeParse(c.req.query('provider'))
      if (!parsed.success) return c.json({ error: 'Valid provider is required' }, 400)
      const denied = await authorize(c, `integrations:read:${parsed.data}`)
      if (denied) return denied
      return c.json(await service.list(parsed.data))
    })
    .post('/connections', zValidator('json', createSchema), async (c) => {
      const body = c.req.valid('json')
      const denied = await authorize(c, `integrations:write:${body.provider}`)
      if (denied) return denied
      try {
        return c.json(
          await service.create({
            providerKey: body.provider,
            adapterVersion: 1,
            displayName: body.displayName,
            configuration: body.configuration,
            credential: body.credential,
            actor: identityActor(c.get('identity')),
          }),
          201
        )
      } catch (error) {
        if (error instanceof IntegrationManualCredentialNotAllowedError) return c.json({ error: error.message }, 400)
        throw error
      }
    })
    .get('/connections/:connectionId', async (c) => {
      const denied = await authorizeConnection(c, service, 'read')
      if (denied) return denied
      const value = await service.get(c.req.param('connectionId'))
      return value ? c.json(value) : c.json({ error: 'Integration connection not found' }, 404)
    })
    .put('/connections/:connectionId/credential', zValidator('json', credentialSchema), async (c) => {
      const denied = await authorizeConnection(c, service, 'write')
      if (denied) return denied
      const body = c.req.valid('json')
      try {
        return c.json(
          await service.replaceCredential(
            c.req.param('connectionId'),
            body.credential,
            identityActor(c.get('identity')),
            body.confirmAssigned
          )
        )
      } catch (error) {
        return usageConflict(c, error)
      }
    })
    .post('/connections/:connectionId/refresh', async (c) => {
      const connectionId = c.req.param('connectionId')
      const denied = await authorizeConnection(c, service, 'write')
      if (denied) return denied
      if (!service.refresh) return c.json({ error: 'Refresh unavailable' }, 404)
      return c.json(await service.refresh(connectionId))
    })
    .put(
      '/providers/:provider/default',
      zValidator('json', z.object({ connectionId: z.string().uuid() }).strict()),
      async (c) => {
        const provider = parseProviderParam(c.req.param('provider'))
        if (!provider || !service.setDefault) return c.json({ error: 'Unsupported integration' }, 404)
        const denied = await authorize(c, `integrations:write:${provider}`)
        if (denied) return denied
        await service.setDefault(provider, c.req.valid('json').connectionId)
        return c.json({ ok: true })
      }
    )
    .post('/connections/:connectionId/validate', async (c) => {
      const denied = await authorizeConnection(c, service, 'write')
      if (denied) return denied
      return c.json(await service.validate(c.req.param('connectionId'), identityActor(c.get('identity'))))
    })
    .post('/connections/:connectionId/enable', async (c) => {
      const denied = await authorizeConnection(c, service, 'write')
      if (denied) return denied
      return c.json(await service.enable(c.req.param('connectionId'), identityActor(c.get('identity'))))
    })
    .post('/connections/:connectionId/disable', zValidator('json', confirmationSchema), async (c) => {
      const denied = await authorizeConnection(c, service, 'write')
      if (denied) return denied
      try {
        await service.disable(
          c.req.param('connectionId'),
          identityActor(c.get('identity')),
          c.req.valid('json').confirmAssigned
        )
        return c.json({ enabled: false })
      } catch (error) {
        return usageConflict(c, error)
      }
    })
    .delete('/connections/:connectionId', async (c) => {
      const denied = await authorizeConnection(c, service, 'write')
      if (denied) return denied
      try {
        await service.remove(
          c.req.param('connectionId'),
          identityActor(c.get('identity')),
          c.req.query('confirmAssigned') === 'true'
        )
        return c.body(null, 204)
      } catch (error) {
        return usageConflict(c, error)
      }
    })
}

export function createSquadIntegrationsRouter(service: SquadIntegrationRoutesService): Hono {
  return new Hono()
    .get(
      '/:squadId/integrations/github/author-defaults',
      requireSquadPermission('integrations:read', 'squadId'),
      async (c) => {
        c.header('Cache-Control', 'no-store')
        return c.json(await resolveDefaultGitHubIdentity(resolvedSquadId(c)))
      }
    )
    .put(
      '/:squadId/integrations/:provider/scope',
      requireSquadPermission('integrations:write', 'squadId'),
      zValidator(
        'json',
        z.object({ enabled: z.boolean().optional(), inheritDefault: z.boolean().optional() }).strict()
      ),
      async (c) => {
        const provider = parseProviderParam(c.req.param('provider'))
        if (!provider || !service.configureScope) return c.json({ error: 'Unsupported integration' }, 404)
        return c.json(await service.configureScope(resolvedSquadId(c), provider, c.req.valid('json')))
      }
    )
    .post(
      '/:squadId/integrations/:provider/execute-environment',
      // Same resolution as every other squad guard — the raw route param may be a short id
      // prefix, which names no squad and would authorize the wrong scope.
      requireSquadPermission('integrations:use', 'squadId'),
      zValidator('json', z.object({ connectionId: z.string().uuid().optional() }).strict()),
      async (c) => {
        const providerKey = parseProviderParam(c.req.param('provider'))
        if (!providerKey || !service.executionEnvironment) return c.json({ error: 'Unsupported integration' }, 404)
        const environment = await service.executionEnvironment(
          resolvedSquadId(c),
          providerKey,
          c.req.valid('json').connectionId
        )
        c.header('Cache-Control', 'no-store')
        if (!environment)
          return c.json(
            {
              error: `No usable ${providerKey === 'github' ? 'GitHub' : providerKey} account is configured for this squad. Enable the integration and connect an account in Settings → Integrations, then check this squad’s integration settings.`,
            },
            409
          )
        return c.json({ environment })
      }
    )
    .post(
      '/:squadId/integrations/github/sign',
      requireSquadPermission('integrations:use', 'squadId'),
      zValidator(
        'json',
        z
          .object({
            payload: z
              .string()
              .min(1)
              .max(Math.ceil((MAX_SIGNING_PAYLOAD_BYTES * 4) / 3) + 4),
          })
          .strict()
      ),
      async (c) => {
        const identity = c.get('identity')
        // Signatures vouch for the connected account; only the squad's agents commit through this path.
        if (identity?.type !== 'agent') return c.json({ error: 'Only agents sign commits through Ficus' }, 403)
        if (!service.signGitObject) return c.json({ error: 'Commit signing is unavailable' }, 404)
        c.header('Cache-Control', 'no-store')
        try {
          const payload = Buffer.from(c.req.valid('json').payload, 'base64')
          return c.json({ signature: await service.signGitObject(resolvedSquadId(c), identity.agentId, payload) })
        } catch (error) {
          if (error instanceof GitHubSignRefused)
            return c.json(
              { error: error.message, code: error.code },
              error.code === 'identity_mismatch' ? 403 : error.code === 'invalid_payload' ? 400 : 409
            )
          throw error
        }
      }
    )
    .get('/:squadId/integrations/:provider', requireSquadPermission('integrations:read', 'squadId'), async (c) => {
      const providerKey = parseProviderParam(c.req.param('provider'))
      if (!providerKey) return c.json({ error: 'Invalid provider' }, 400)
      const selection = await service.selection(resolvedSquadId(c), providerKey)
      return c.json({
        providerKey,
        ...(selection.scope ? { scope: selection.scope } : {}),
        assignment: selection.assignment ? redactSummary(selection.assignment) : null,
        connections: selection.connections.map(redactSummary),
        ...(selection.attached
          ? { attached: selection.attached.map((row) => ({ ...redactSummary(row), isDefault: row.isDefault })) }
          : {}),
        ...(selection.projection === undefined ? {} : { projection: selection.projection }),
      })
    })
    .put(
      '/:squadId/integrations/:provider/assignment',
      requireSquadPermission('integrations:write', 'squadId'),
      zValidator('json', assignmentSchema),
      async (c) => {
        const providerKey = parseProviderParam(c.req.param('provider'))
        if (!providerKey) return c.json({ error: 'Invalid provider' }, 400)
        return c.json(
          redactSummary(
            await service.assign(
              resolvedSquadId(c),
              providerKey,
              c.req.valid('json').connectionId,
              assignmentActor(c.get('identity')),
              ...(c.req.valid('json').makeDefault === undefined ? [] : [c.req.valid('json').makeDefault])
            )
          )
        )
      }
    )
    .post(
      '/:squadId/integrations/:provider/projection/retry',
      requireSquadPermission('integrations:write', 'squadId'),
      async (c) => {
        const providerKey = parseProviderParam(c.req.param('provider'))
        if (!providerKey) return c.json({ error: 'Invalid provider' }, 400)
        return c.json({ projection: await service.retryProjection(resolvedSquadId(c), providerKey) })
      }
    )
    .delete(
      '/:squadId/integrations/:provider/assignment',
      requireSquadPermission('integrations:write', 'squadId'),
      async (c) => {
        const providerKey = parseProviderParam(c.req.param('provider'))
        if (!providerKey) return c.json({ error: 'Invalid provider' }, 400)
        const connectionId = c.req.query('connectionId')
        if (connectionId !== undefined && !z.string().uuid().safeParse(connectionId).success)
          return c.json({ error: 'Invalid connection' }, 400)
        await service.unassign(
          resolvedSquadId(c),
          providerKey,
          assignmentActor(c.get('identity')),
          ...(connectionId ? [connectionId] : [])
        )
        return c.body(null, 204)
      }
    )
}

function assignmentActor(identity: Identity | undefined): IntegrationAssignmentActor | undefined {
  if (identity?.type === 'user') return { userId: identity.userId }
  if (identity?.type === 'agent') return { agentId: identity.agentId }
  return undefined
}

async function authorize(c: any, permission: string): Promise<Response | null> {
  const identity: Identity | undefined = c.get('identity')
  if (!identity) return c.json({ error: 'Unauthorized' }, 401)
  c.set('authzChecked', true)
  return (await hasPermission(identity, permission)) ? null : c.json({ error: 'Forbidden' }, 403)
}

async function authorizeConnection(
  c: any,
  service: Pick<IntegrationRoutesService, 'providerFor'>,
  action: 'read' | 'write'
): Promise<Response | null> {
  const identity: Identity | undefined = c.get('identity')
  if (!identity) return c.json({ error: 'Unauthorized' }, 401)
  c.set('authzChecked', true)
  const providerKey = parseProviderParam((await service.providerFor(c.req.param('connectionId'))) ?? '')
  if (!providerKey) return c.json({ error: 'Integration connection not found' }, 404)
  return (await hasPermission(identity, `integrations:${action}:${providerKey}`))
    ? null
    : c.json({ error: 'Forbidden' }, 403)
}

function redactSummary(connection: IntegrationConnectionSummary): IntegrationConnectionSummary {
  return {
    id: connection.id,
    providerKey: connection.providerKey,
    displayName: connection.displayName,
    enabled: connection.enabled,
    healthState: connection.healthState,
  }
}

/** Names a provider in a sentence ("connect GitHub"); unknown keys stay generic. */
const INTEGRATION_LABELS: Record<string, string> = {
  bigbrain: 'Bigbrain',
  github: 'GitHub',
  linear: 'Linear',
  notion: 'Notion',
}

function integrationLabel(providerKey: string): string {
  return INTEGRATION_LABELS[providerKey] ?? 'this integration'
}

function parseProviderParam(value: string): string | null {
  const parsed = providerKeySchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

function usageConflict(c: any, error: unknown): Response {
  if (error instanceof IntegrationManualCredentialNotAllowedError) {
    return c.json({ error: error.message }, 400)
  }
  if (error instanceof IntegrationConnectionInUseError) {
    return c.json({ error: error.message, usage: error.usage }, 409)
  }
  throw error
}

type AuthorizationOperation = 'start' | 'poll' | 'cancel' | 'callback' | 'complete'

/**
 * Map expected authorization failures to typed JSON and log each rejection at
 * warn with its stable code only; provider bodies, tokens and secrets are never logged.
 */
function authorizationFailure(
  c: any,
  error: unknown,
  providerKey: string,
  operation: AuthorizationOperation
): Response {
  if (error instanceof GitHubFeedbackError) return c.json({ error: error.code, code: error.code }, error.status)
  if (error instanceof AuthorizationFlowError) {
    const status = error.code === 'broker_unconfigured' ? 503 : 400
    log.warn(`${providerKey} authorization ${operation} rejected: ${error.code} (HTTP ${status})`)
    // `error` stays the bare code: web callback handling keys terminal states on it.
    return c.json({ error: error.code, code: error.code }, status)
  }
  if (error instanceof GitHubOAuthError) {
    const failure = describeGitHubAuthorizationError(error)
    log.warn(
      `${providerKey} authorization ${operation} failed at GitHub: ${failure.code} (HTTP ${failure.status}` +
        `${error.status ? `, GitHub HTTP ${error.status}` : ''})`
    )
    if (failure.retryAfterSeconds !== undefined) c.header('Retry-After', String(failure.retryAfterSeconds))
    return c.json({ error: failure.message, code: failure.code }, failure.status)
  }
  throw error
}

function identityActor(identity: unknown): string {
  if (!identity || typeof identity !== 'object') return 'unknown'
  const value = identity as { userId?: string; agentId?: string; systemTokenId?: string }
  if (value.userId) return `user:${value.userId}`
  if (value.agentId) return `agent:${value.agentId}`
  return value.systemTokenId ? `token:${value.systemTokenId}` : 'unknown'
}
