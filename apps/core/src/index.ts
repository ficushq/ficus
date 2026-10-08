import { RuntimeReadiness } from './lib/infra/readiness'
import { mountCoreDocs } from './lib/docs-serve'
import {
  getOpenAIServiceKey,
  initializeOpenAIServicesState,
  OPENAI_SERVICES_ENABLED_KEY,
} from './services/integrations/openai-services/settings'
import { Hono } from 'hono'
import { CSRF_HEADER } from '@ficus/shared/http-headers'
import { upgradeWebSocket, websocket } from 'hono/bun'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import { agentTypesRoutes } from './routes/agent-types'
import { modelTiersRoutes } from './routes/model-tiers'
import { skillsRoutes } from './routes/skills'
import { sharedPromptsRoutes } from './routes/shared-prompts'
import { assistantRouter } from './routes/assistant'
import { assistantTasksRouter } from './routes/assistant-tasks'
import { chatRouter } from './routes/chat'
import { pushRouter } from './routes/push'

import { webhooksRouter, webhooksStatusRouter } from './routes/webhooks'
import { authRouter } from './routes/auth'
import { sessionsRouter } from './routes/sessions'
import { usersRouter } from './routes/users'
import { rolesRouter } from './routes/roles'
import { transcribeRouter } from './routes/transcribe'
import { ttsRouter } from './routes/tts'
import { voiceSessionRouter } from './routes/voice-session'
import { voiceRouter } from './routes/voice'
import { aiExtractRouter } from './routes/ai-extract'
import { actionsRouter } from './routes/actions'
import { agentQuestionsRouter } from './routes/agent-questions'
import { systemTokensRouter } from './routes/system-tokens'
import { imagesRouter } from './routes/images'
import { agentsRouter } from './routes/agents'
import { agentFilesRouter } from './routes/agent-files'
import { agentDeliverySuggestionRouter } from './routes/agent-delivery-suggestion'
import { artifactsRouter } from './routes/artifacts'
import { inboxRouter } from './routes/inbox'
import { squadPresetsRouter } from './routes/squad-presets'
import { workflowsRouter } from './routes/workflows'
import { squadsRouter } from './routes/squads'
import { slotResourcesRouter, slotsRouter } from './routes/slots'
import { activityRouter } from './routes/activity'
import { deploymentsRouter } from './routes/deployments'
import { channelLinksRouter } from './routes/channel-links'
import { channelInstancesRouter } from './routes/channel-instances'
import { terminalRouter } from './routes/terminal'
import { squadRelationshipsRouter } from './routes/squad-relationships'
import { workStreamsRouter } from './routes/work-streams'
import { searchRouter } from './routes/search'
import { schedulesRouter } from './routes/schedules'
import { monitorsRouter } from './routes/monitors'
import { operationsRecommendationsRouter } from './routes/recommendations'
import { squadSshRouter } from './routes/squad-ssh'
import { squadEnvRouter } from './routes/squad-env'
import { memoryRouter } from './routes/memory'
import { grantsRouter } from './routes/grants'
import { createIntegrationsRouter, createSquadIntegrationsRouter } from './routes/integrations'
import {
  exportConsentService,
  integrationRoutesService,
  squadIntegrationRoutesService,
} from './services/integrations/runtime'
import { createExternalExportRouter } from './routes/external-export'
import { Agent } from './entities/Agent'
import { routingRouter } from './routes/routing'
import { amtpRouter } from './routes/amtp'
import { userPreferencesRouter } from './routes/user-preferences'
import { farmPreferencesRouter } from './routes/farm-preferences'
import { farmChatRouter } from './routes/farm-chat'
import { themePresetsRouter } from './routes/theme-presets'
import { notificationConfigRouter } from './routes/notification-config'
import secretsRouter from './routes/secrets'
import settingsRouter from './routes/settings'
import systemRouter from './routes/system'
import updatesRouter from './routes/updates'
import providerAuthRouter from './routes/provider-auth'
import decisionsRouter from './routes/decisions'
import machinesRouter from './routes/machines'
import adminRouter from './routes/admin'
import demoRouter from './routes/demo'
import remoteHostsRouter from './routes/remote-hosts'
import onboardingRouter from './routes/onboarding'
import { startAuthCleanupScheduler, stopAuthCleanupScheduler } from './services/auth/cleanup-scheduler'
import {
  startToolchainStateCleanupScheduler,
  stopToolchainStateCleanupScheduler,
} from './services/sandbox/toolchain/cleanup-scheduler'
import { startLocalUpdateScheduler, stopLocalUpdateScheduler } from './services/updates'
import { getSecretStore } from './services/secrets'
import { resolveTokenContext, type AuthContext } from './services/auth/resolve-token'
import { consumeWsTicket } from './services/auth/ws-ticket'
import type { Identity } from './services/rbac'
import { hasPermission } from './services/rbac'
import { regenerateEnvFilesForSecretKey } from './services/squad/env'
import { getSettingsStore, SETTINGS_STORE_REFRESH_INTERVAL_MS } from './services/settings'
import { registerOnboardingEventSources } from './services/onboarding/events'
import {
  authzSentinel,
  identityMiddleware,
  jsonBodyErrorHandler,
  jsonBodyErrorMiddleware,
  requirePermission,
} from './middleware'
import {
  initializeWebhooks,
  loadWebhookActionConfig,
  setGithubActionConfig,
  setLinearActionConfig,
} from './services/webhooks'

import { waitForDbAndMigrate } from './db'
import { installPgTeardownRejectionGuard } from './db/connection'
import { reconcileKeylessAmtpRegistrations } from './services/amtp/registration-reconciliation'
import { syncAllConfig } from './services/config-sync'
import { ensureSessionDataDir } from './lib/infra/session-files'
import { wsManager } from './services/ws/manager'
import { createTerminalWebSocketHandlers, getTerminalParams } from './services/ws/terminal'
import { createLogsWebSocketHandlers, getLogsParams } from './services/ws/logs'
import { createSystemLogsWebSocketHandlers, getSystemLogsParams } from './services/ws/system-logs'
import { initializeSystemLogProvider } from './services/system-logs/factory'
import { getSquadIdFromSandbox } from './services/sandbox/types'
import { terminalManager } from './services/sandbox/docker/terminal'
import { getSandboxManager, isHostRuntime, isK8sRuntime, isVmRuntime, validateSandboxSetup } from './services/sandbox'
import { ignoredK8sEnvWarning, requireSandboxRuntime } from './services/sandbox/runtime'
import { setupEventBridge } from './services/ws/bridge'
import { join } from 'path'
import { notificationService } from './services/notifications'
import { eventEmitter } from './lib/infra/event-emitter'
import {
  notify,
  listen,
  configureLocalEvents,
  handleInternalEventPost,
  INTERNAL_EVENTS_PATH,
} from './lib/infra/local-events'
import { startWorkerHealthMonitor, stopWorkerHealthMonitor, getWorkerStatus } from './services/worker'
import { startDiscordGateway, stopDiscordGateway } from './channels/discord'
import { EmbeddingWorker, ExternalSourceReindexRunner, registerThreadIndexerEvents } from './services/memory'
import { ServerWebSocket } from 'bun'
import { getVapidKeys } from './services/push'
import { registerLiveActivityFanout, type LiveActivityFanout } from './services/push/live-activity'
import { ensureHomeDir } from './lib/utils/home'
import { WSEvents } from 'hono/ws'
import { Permissions } from '@ficus/shared'
import { Squad } from './entities/Squad'
import { WEBHOOKS_DIR } from './lib/paths'
import { createLogger, installConsoleContentSanitizer } from './lib/infra/logger'
import { apiBindHost } from './lib/infra/bind-host'
import { captureHeapSnapshot } from './lib/infra/heap-snapshot'
import { subsystem, startSubsystems, stopSubsystems, type Subsystem } from './lib/infra/subsystem'
import { registerAgentActivityEventHandlers } from './services/agents/activity-summary'
import { registerSquadActivityEventHandlers } from './services/squad-activity/event-handlers'
import { maybeMountWebUi } from './lib/web-serve'
import { corsAllowOrigins, normalizeOrigin, isAllowedWsOrigin } from './services/auth/web-origins'
import { extractSessionToken, getSessionCookie } from './services/auth/session-cookie'
import { csrfProtection } from './middleware/csrf'
import { redactHttpLogCredentials } from './lib/infra/http-log'
import { attachPeerAddress, getClientAddress } from './lib/client-address'
import { getSandboxProvisionErrorResponse } from './routes/sandbox-provision-error'
import { withDeviceRevocation } from './services/ws/device-revocation'
import {
  startDeviceConnectionRevocation,
  stopDeviceConnectionRevocation,
} from './services/auth/device-connection-registry'

installConsoleContentSanitizer()
const log = createLogger('server', undefined, { color: 'cyan' })
const httpLog = createLogger('http', undefined, { color: 'cyan' })

const heapSnapshotDirectory = process.env.FICUS_HEAP_SNAPSHOT_DIR
if (heapSnapshotDirectory) {
  process.on('SIGUSR2', () => {
    void captureHeapSnapshot({ role: 'api', directory: heapSnapshotDirectory })
      .then((path) => log.info(`Heap snapshot captured at ${path}`))
      .catch((error) => log.error('Heap snapshot capture failed:', error))
  })
}

export const app = new Hono()

app.use('*', jsonBodyErrorMiddleware)
app.onError((error, c) => {
  // Sandbox provisioning back-pressure answers 503 + Retry-After. It must be checked
  // before the shared handler, which would otherwise flatten it into a generic 500 and
  // strip the retry hint callers rely on instead of parsing message text.
  const provisioning = getSandboxProvisionErrorResponse(error)
  if (provisioning) {
    if (provisioning.retryAfter) c.header('Retry-After', provisioning.retryAfter)
    return c.json(provisioning.body, provisioning.status)
  }
  // Everything else keeps main's semantics: malformed JSON -> 400, HTTPException, 500.
  return jsonBodyErrorHandler(error, c)
})

// Identify the caller on the request line. Hono's `logger` only sees a formatted
// string, so the peer/user-agent it cannot reach are logged here instead.
//
// Without this an unexplained request storm is undiagnosable: every caller on the
// instance is 127.0.0.1 (core never terminates TLS, and sandboxes reach it through
// the VM's NAT), and HTTP keep-alive means connection counts do not map to callers
// either. Diagnosing one such storm cost hours and three wrong conclusions —
// "sandbox agents", then "a browser tab", then back again — none of which a single
// log field would have allowed.
//
// `getClientAddress` already applies the trusted-proxy rules, so this reports the
// real client rather than the proxy. The user-agent distinguishes the ficus CLI from
// the web app from the mobile app, which is the distinction that actually matters
// and which no amount of connection forensics can recover. It is truncated because
// it is attacker-controlled free text, and only emitted for `<--` request lines so
// each request stays one line.
app.use('*', async (c, next) => {
  const ua = c.req.header('user-agent')
  httpLog.info(
    `<-- ${c.req.method} ${c.req.path} client=${getClientAddress(c.req.raw)} ua=${ua ? redactHttpLogCredentials(ua.slice(0, 80)) : 'none'}`
  )
  await next()
})
app.use(
  '*',
  // Hono emits both `<--` (request) and `-->` (response). The middleware above
  // already prints an enriched request line, so drop Hono's plain one rather than
  // logging every request twice; `-->` still carries status and duration.
  logger((msg) => {
    if (msg.startsWith('<--')) return
    httpLog.info(redactHttpLogCredentials(msg))
  })
)
app.use(
  '*',
  cors({
    // Reflect only allowlisted web origins so credentialed (cookie) cross-origin
    // requests are accepted; non-browser callers (CLI/agents) send no Origin.
    origin: (origin) => {
      const normalized = normalizeOrigin(origin)
      return normalized && corsAllowOrigins().includes(normalized) ? origin : null
    },
    credentials: true,
    allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization', 'X-Auth-Token', CSRF_HEADER],
  })
)

const readiness = new RuntimeReadiness('api', process.env.FICUS_RUNTIME_INSTANCE_ID)
app.get('/ready', () => readiness.response())
app.get('/health', (c) => c.json({ status: 'ok' }))

// Cross-process events from ficus-worker (see lib/infra/local-events.ts). Not
// under /api, so it carries none of the browser auth middleware below — it is
// authenticated inside the handler with the resolved internal event token
// (explicit, encryption-key-derived, or random fail-closed fallback).
app.post(INTERNAL_EVENTS_PATH, (c) => handleInternalEventPost(c.req.raw))

// CSRF protection for cookie-authenticated browser requests (also covers /api/auth).
app.use('/api/*', csrfProtection)

// Unprotected routes (before auth middleware)
app.route('/api/auth', authRouter)
app.route('/api/webhooks', webhooksRouter)

// Identity middleware — resolves identity for all remaining /api/* routes
app.use('/api/*', identityMiddleware)
// Runtime RBAC fail-closed backstop for matched API routes.
app.use('/api/*', authzSentinel)

// RBAC routers (identity required)
app.route('/api/webhooks', webhooksStatusRouter)
app.route('/api/sessions', sessionsRouter)
app.route('/api/users', usersRouter)
app.route('/api/roles', rolesRouter)

// Worker status is non-sensitive online/offline infra state; gate behind a
// permission both Operators and Viewers already hold rather than the
// previously-undefined 'system:worker-status' (which only Admin's '*' matched).
app.get('/api/worker/status', requirePermission('squads:read'), (c) => c.json({ status: getWorkerStatus() }))
app.route('/api/skills', skillsRoutes)
app.route('/api/shared-prompts', sharedPromptsRoutes)
app.route('/api/agent-types', agentTypesRoutes)
app.route('/api/model-tiers', modelTiersRoutes)
app.route('/api/chat', chatRouter)
app.route('/api/assistant', assistantRouter)
app.route('/api/assistant-tasks', assistantTasksRouter)
app.route('/api/actions', actionsRouter)
app.route('/api/agent-questions', agentQuestionsRouter)
app.route('/api/system-tokens', systemTokensRouter)
app.route('/api/push', pushRouter)
app.route('/api/transcribe', transcribeRouter)
app.route('/api/tts', ttsRouter)
app.route('/api/voice-session', voiceSessionRouter)
app.route('/api/voice', voiceRouter)
app.route('/api/ai/extract', aiExtractRouter)

app.route('/api/images', imagesRouter)
app.route('/api/agents', agentFilesRouter)
app.route('/api/agents', agentDeliverySuggestionRouter)
app.route('/api/agents', agentsRouter)
app.route(
  '/api/agents',
  createExternalExportRouter({
    service: exportConsentService,
    findAgent: async (id) => {
      const agent = await Agent.find(id)
      return agent ? { id: agent.id, squadId: agent.squadId, parentAgentId: agent.parentAgentId } : null
    },
    authorize: (identity, squadId, permission) => hasPermission(identity, permission, squadId),
  })
)
app.route('/api/artifacts', artifactsRouter)
app.route('/api/inbox', inboxRouter)
app.route('/api/squad-presets', squadPresetsRouter)
app.route('/api/workflows', workflowsRouter)
app.route('/api/squads', squadsRouter)
app.route('/api/squads', slotsRouter)
app.route('/api/slots', slotResourcesRouter)
app.route('/api/activity', activityRouter)
app.route('/api/integrations', createIntegrationsRouter(integrationRoutesService))
app.route('/api/squads', createSquadIntegrationsRouter(squadIntegrationRoutesService))
app.route('/api', deploymentsRouter)
app.route('/api/channel-links', channelLinksRouter)
app.route('/api/channel-instances', channelInstancesRouter)
app.route('/api/squad-relationships', squadRelationshipsRouter)
app.route('/api/workstreams', workStreamsRouter)
app.route('/api/search', searchRouter)
app.route('/api/memory', memoryRouter)
app.route('/api', grantsRouter)
app.route('/api/routing', routingRouter)
app.route('/api/notification-config', notificationConfigRouter)
app.route('/api/user-preferences', userPreferencesRouter)
app.route('/api/farm-preferences', farmPreferencesRouter)
app.route('/api/farm-chat', farmChatRouter)
app.route('/api/theme-presets', themePresetsRouter)
app.route('/api/secrets', secretsRouter)
app.route('/api/settings', settingsRouter)
app.route('/api/system', systemRouter)
app.route('/api/updates', updatesRouter)
app.route('/api/machines', machinesRouter)
app.route('/api/admin', adminRouter)
app.route('/api/demo', demoRouter)
app.route('/api/remote-hosts', remoteHostsRouter)
app.route('/api/onboarding', onboardingRouter)
app.route('/api/provider-auth', providerAuthRouter)
app.route('/api/decisions', decisionsRouter)
app.route('/api/schedules', schedulesRouter)
app.route('/api/monitors', monitorsRouter)
app.route('/api/recommendations', operationsRecommendationsRouter)
app.route('/api/squads/ssh', squadSshRouter)
app.route('/api/squads/workspace', squadEnvRouter)
app.route('/api/terminal', terminalRouter)
app.route('/api/amtp', amtpRouter)

export async function authenticateWsRequest(url: string, cookieToken?: string): Promise<AuthContext | null> {
  const parsed = new URL(url)
  // Browsers present a single-use ?ticket= (so the session bearer never sits in
  // the URL); non-browser clients (agent tokens) still present ?token=. The
  // HttpOnly session cookie (sent on same-/same-site handshakes) is the fallback.
  const ticket = parsed.searchParams.get('ticket')
  if (ticket) return consumeWsTicket(ticket)
  const token = parsed.searchParams.get('token') ?? cookieToken
  return token ? resolveTokenContext(token) : null
}

export type TerminalAuthorizationResult =
  | { ok: true; identity: Identity; authContext: AuthContext; params: { sandboxId: string; sessionId: string | null } }
  | { ok: false; status: 401 | 403 }

export async function authorizeTerminalRequest(
  url: string,
  cookieToken?: string
): Promise<TerminalAuthorizationResult> {
  const parsed = new URL(url)
  // Single-use ?ticket= (browsers) takes precedence over ?token= (agent tokens);
  // the HttpOnly session cookie is the fallback so no bearer rides the URL.
  const ticket = parsed.searchParams.get('ticket')
  const token = parsed.searchParams.get('token') ?? cookieToken
  const authContext = ticket ? await consumeWsTicket(ticket) : token ? await resolveTokenContext(token) : null
  if (!authContext) return { ok: false, status: 401 }
  const { identity } = authContext

  const sessionId = parsed.searchParams.get('sessionId')
  const directSandboxId = parsed.searchParams.get('sandboxId')
  const squadParam = parsed.searchParams.get('squadId')
  const sandboxId = directSandboxId ?? (squadParam ? Squad.getSandboxId(squadParam) : null)
  if (!sandboxId) return { ok: false, status: 403 }

  const squadId = getSquadIdFromSandbox(sandboxId)
  const allowed = squadId
    ? await hasPermission(identity, Permissions.TERMINAL_ACCESS, squadId)
    : await hasPermission(identity, Permissions.TERMINAL_ACCESS)
  if (!allowed) return { ok: false, status: 403 }

  return { ok: true, identity, authContext, params: { sandboxId, sessionId } }
}

export async function authorizeSandboxLogsRequest(
  url: string,
  sandboxId: string | undefined,
  cookieToken?: string
): Promise<{ ok: true; identity: Identity; authContext: AuthContext } | { ok: false; status: 401 | 403 }> {
  const parsed = new URL(url)
  const ticket = parsed.searchParams.get('ticket')
  const token = parsed.searchParams.get('token') ?? cookieToken
  const authContext = ticket ? await consumeWsTicket(ticket) : token ? await resolveTokenContext(token) : null
  if (!authContext) return { ok: false, status: 401 }
  const { identity } = authContext
  if (!sandboxId) return { ok: false, status: 403 }

  const squadId = getSquadIdFromSandbox(sandboxId)
  // Only squad sandboxes are supported today; other kinds are rejected here.
  if (!squadId) return { ok: false, status: 403 }
  const allowed = await hasPermission(identity, Permissions.SANDBOX_LOGS, squadId)
  return allowed ? { ok: true, identity, authContext } : { ok: false, status: 403 }
}

export async function authorizeSystemLogsRequest(
  url: string,
  cookieToken?: string
): Promise<{ ok: true; identity: Identity; authContext: AuthContext } | { ok: false; status: 401 | 403 }> {
  const parsed = new URL(url)
  const ticket = parsed.searchParams.get('ticket')
  const token = parsed.searchParams.get('token') ?? cookieToken
  const authContext = ticket ? await consumeWsTicket(ticket) : token ? await resolveTokenContext(token) : null
  if (!authContext) return { ok: false, status: 401 }
  const { identity } = authContext

  const allowed = await hasPermission(identity, Permissions.SYSTEM_LOGS)
  return allowed ? { ok: true, identity, authContext } : { ok: false, status: 403 }
}

// Set up WebSocket upgrade handler (identity auth via query token)
app.get(
  '/ws',
  async (c, next) => {
    // CSWSH defense: CORS/CSRF don't gate WS upgrades, and the ambient session
    // cookie rides cross-site handshakes under SameSite=None. Reject any browser
    // handshake whose Origin isn't allowlisted (a missing Origin = non-browser).
    if (!isAllowedWsOrigin(c.req.header('origin'))) return c.json({ error: 'Forbidden' }, 403)
    const authContext = await authenticateWsRequest(c.req.url, getSessionCookie(c))
    if (!authContext) return c.json({ error: 'Unauthorized' }, 401)
    c.set('identity', authContext.identity)
    c.set('authContext', authContext)
    return next()
  },
  upgradeWebSocket((c) =>
    withDeviceRevocation(c.get('authContext'), {
      onOpen(_, ws) {
        wsManager.addClient(ws.raw as ServerWebSocket, c.get('identity'))
      },
      onMessage(event, ws) {
        wsManager.handleMessage(ws.raw as ServerWebSocket, String(event.data))
      },
      onClose(_, ws) {
        wsManager.removeByWs(ws.raw as ServerWebSocket)
      },
      onError(event, ws) {
        wsManager.removeByWs(ws.raw as ServerWebSocket)
        log.error('WebSocket error:', event, ws)
      },
    })
  )
)

// Set up Terminal WebSocket handler
app.get(
  '/ws/terminal',
  async (c, next) => {
    // CSWSH defense (see /ws): a cross-site WS handshake would otherwise ride the
    // ambient cookie straight into a shell PTY. Reject non-allowlisted Origins.
    if (!isAllowedWsOrigin(c.req.header('origin'))) return c.json({ error: 'Forbidden' }, 403)
    const authorized = await authorizeTerminalRequest(c.req.url, getSessionCookie(c))
    if (!authorized.ok) {
      const error = authorized.status === 401 ? 'Unauthorized' : 'Forbidden'
      return c.json({ error }, authorized.status)
    }
    c.set('identity', authorized.identity)
    c.set('authContext', authorized.authContext)
    return next()
  },
  upgradeWebSocket((c): WSEvents<ServerWebSocket> => {
    const params = getTerminalParams(c)
    const handlers = params
      ? createTerminalWebSocketHandlers(params.sandboxId, params.sessionId)
      : {
          onOpen(_: Event, ws: Parameters<NonNullable<WSEvents<ServerWebSocket>['onOpen']>>[1]) {
            ws.raw?.close(4000, 'sandboxId, taskId, or squadId query parameter is required')
          },
          onMessage() {},
          onClose() {},
          onError() {},
        }
    return withDeviceRevocation(c.get('authContext'), handlers)
  })
)

// Set up Sandbox Logs WebSocket handler
app.get(
  '/ws/sandbox/:sandboxId/logs',
  async (c, next) => {
    if (!isAllowedWsOrigin(c.req.header('origin'))) return c.json({ error: 'Forbidden' }, 403)
    const authorized = await authorizeSandboxLogsRequest(c.req.url, c.req.param('sandboxId'), getSessionCookie(c))
    if (!authorized.ok) {
      const error = authorized.status === 401 ? 'Unauthorized' : 'Forbidden'
      return c.json({ error }, authorized.status)
    }
    c.set('identity', authorized.identity)
    c.set('authContext', authorized.authContext)
    return next()
  },
  upgradeWebSocket((c): WSEvents<ServerWebSocket> => {
    const params = getLogsParams(c)
    const handlers = params
      ? createLogsWebSocketHandlers(params)
      : {
          onOpen(_: Event, ws: Parameters<NonNullable<WSEvents<ServerWebSocket>['onOpen']>>[1]) {
            ws.raw?.close(4000, 'sandboxId path parameter is required')
          },
          onMessage() {},
          onClose() {},
          onError() {},
        }
    return withDeviceRevocation(c.get('authContext'), handlers)
  })
)

// Set up System Logs WebSocket handler
app.get(
  '/ws/system/logs',
  async (c, next) => {
    if (!isAllowedWsOrigin(c.req.header('origin'))) return c.json({ error: 'Forbidden' }, 403)
    const authorized = await authorizeSystemLogsRequest(c.req.url, extractSessionToken(c))
    if (!authorized.ok) {
      const error = authorized.status === 401 ? 'Unauthorized' : 'Forbidden'
      return c.json({ error }, authorized.status)
    }
    c.set('identity', authorized.identity)
    c.set('authContext', authorized.authContext)
    return next()
  },
  upgradeWebSocket((c): WSEvents<ServerWebSocket> => {
    const params = getSystemLogsParams(c)
    const handlers = params
      ? createSystemLogsWebSocketHandlers(params)
      : {
          onOpen(_: Event, ws: Parameters<NonNullable<WSEvents<ServerWebSocket>['onOpen']>>[1]) {
            ws.raw?.close(4000, 'Invalid parameters')
          },
          onMessage() {},
          onClose() {},
          onError() {},
        }
    return withDeviceRevocation(c.get('authContext'), handlers)
  })
)

// Release-matched documentation is always available, including on cloud instances.
mountCoreDocs(app)
// Optional: serve the built web UI on the same port (single-origin deployments).
maybeMountWebUi(app, log)

// Ordered start/stop subsystem list — boot iterates this forward, shutdown
// (gracefulShutdown, via stopSubsystems) iterates it in reverse. List order
// matches these subsystems' relative boot call order. discord-gateway's
// standalone start used to run later — after EmbeddingWorker.start(), the
// settings/secret onChange listener registrations, and right before
// ensureSandboxesForLiveManagedLocalDeployments() + the K8s reconcile block.
// Folding it into this list starts it before those, which is safe: the
// gateway's connect/handleMessageCreate path touches only Agent,
// InboxMessage, ChannelInstance, and the provider registry — none of the
// init that now runs after it.
let unregisterSquadActivity: (() => void) | null = null
let unregisterAgentActivity: (() => void) | null = null
let liveActivityFanout: LiveActivityFanout | null = null

const subsystems: Subsystem[] = [
  subsystem(
    'squad-activity-materialization',
    () => {
      unregisterSquadActivity = registerSquadActivityEventHandlers()
      // Keeps agents.last_message_at/_human_/preview current. Registered in
      // BOTH processes: either can be the one that writes a message, and the
      // summary must not depend on which.
      unregisterAgentActivity = registerAgentActivityEventHandlers()
    },
    () => {
      unregisterSquadActivity?.()
      unregisterSquadActivity = null
      unregisterAgentActivity?.()
      unregisterAgentActivity = null
    }
  ),
  subsystem(
    'live-activity-fanout',
    () => {
      liveActivityFanout = registerLiveActivityFanout(eventEmitter)
    },
    () => {
      liveActivityFanout?.stop()
      liveActivityFanout = null
    }
  ),
  subsystem(
    'worker-health-monitor',
    () => startWorkerHealthMonitor(),
    () => stopWorkerHealthMonitor()
  ),
  subsystem(
    'external-source-reindex-runner',
    () => ExternalSourceReindexRunner.instance().start(),
    () => ExternalSourceReindexRunner.instance().stop()
  ),
  subsystem(
    'local-update-scheduler',
    () => {
      startLocalUpdateScheduler()
    },
    () => stopLocalUpdateScheduler()
  ),
  subsystem(
    'auth-cleanup-scheduler',
    () => {
      startAuthCleanupScheduler()
    },
    () => stopAuthCleanupScheduler()
  ),
  subsystem(
    'toolchain-state-cleanup-scheduler',
    () => {
      startToolchainStateCleanupScheduler()
    },
    () => stopToolchainStateCleanupScheduler()
  ),
  subsystem(
    'integration-event-polling',
    async () => {
      const { integrationEventPollingRuntime } = await import('./services/integrations/runtime')
      integrationEventPollingRuntime.start()
    },
    async () => {
      const { integrationEventPollingRuntime } = await import('./services/integrations/runtime')
      await integrationEventPollingRuntime.stop()
    }
  ),
  subsystem(
    'hosted-integration-relay',
    async () => {
      const { hostedIntegrationRelayRuntime } = await import('./services/integrations/relay/runtime')
      hostedIntegrationRelayRuntime.start()
    },
    async () => {
      const { hostedIntegrationRelayRuntime } = await import('./services/integrations/relay/runtime')
      await hostedIntegrationRelayRuntime.stop()
    }
  ),
  subsystem(
    'hosted-slack-relay',
    async () => {
      const { hostedSlackRelayRuntime } = await import('./services/integrations/relay/slack-runtime')
      hostedSlackRelayRuntime.start()
    },
    async () => {
      const { hostedSlackRelayRuntime } = await import('./services/integrations/relay/slack-runtime')
      await hostedSlackRelayRuntime.stop()
    }
  ),
  subsystem(
    'slack-dispatch-receipt-sweep',
    async () => {
      const { slackDispatchReceiptSweepWorker } = await import('./services/integrations/relay/slack-receipt-sweep')
      slackDispatchReceiptSweepWorker.start()
    },
    async () => {
      const { slackDispatchReceiptSweepWorker } = await import('./services/integrations/relay/slack-receipt-sweep')
      await slackDispatchReceiptSweepWorker.stop()
    }
  ),
  // Catch-all: stop any registered periodic runner (settings/secrets cache
  // refresh, embedding worker, etc.) the explicit list above doesn't cover.
  // stop() is idempotent, so the explicit stops above (which also clear
  // module state) are unaffected.
  subsystem(
    'periodic-runners:catch-all',
    () => {},
    async () => {
      const { stopAllPeriodicRunners } = await import('./lib/infra/PeriodicRunner')
      await stopAllPeriodicRunners()
    }
  ),
  subsystem('device-connection-revocation', startDeviceConnectionRevocation, stopDeviceConnectionRevocation),
  // Discord Gateway for thread message events. start() is a config no-op
  // when DISCORD_BOT_TOKEN isn't set (checked inside startDiscordGateway
  // itself); stop() is safe to call unconditionally in that case too — the
  // module-level `gateway` singleton is simply still null.
  subsystem(
    'discord-gateway',
    () => startDiscordGateway(),
    () => stopDiscordGateway()
  ),
]

/**
 * Runs validateSandboxSetup() NON-FATALLY: a missing sandbox image must not
 * take the api down (agents fail later, the rest of the product still works).
 *
 * The error is LOGGED, though. This catch used to be empty on the claim that
 * the error was "already logged" — true only of the image-missing branch,
 * which logs before it throws. Everything else validateSandboxSetup can raise
 * (most importantly `docker-sysbox requested but sysbox is not installed`)
 * disappeared without a trace, leaving an api that looks healthy and cannot
 * start a single sandbox. The runtime CHECK itself is separate and fatal — see
 * the requireSandboxRuntime guard at the top of the boot block.
 *
 * `validate` is a parameter only so this is unit-testable.
 */
export function runSandboxSetupValidation(validate: () => void = validateSandboxSetup): void {
  try {
    validate()
  } catch (error) {
    log.error('Sandbox setup validation failed:', error)
  }
}

if (import.meta.main) {
  // FICUS_SANDBOX_RUNTIME is mandatory and explicit — no default, no
  // auto-detection. Refuse to boot rather than serve an api whose agents can
  // never get a sandbox. This is deliberately OUTSIDE the sandbox-image
  // validation try/catch below: that one swallows its error so a missing sandbox
  // IMAGE does not stop the api, but a missing/unknown RUNTIME must.
  try {
    requireSandboxRuntime()
  } catch (error) {
    log.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }

  // Every FICUS_K8S_* key applies ONLY to the k8s runtime. Say so once at boot,
  // or a stale line an operator left behind when they switched runtimes reads
  // as live configuration.
  const ignoredK8sEnv = ignoredK8sEnvWarning()
  if (ignoredK8sEnv) log.warn(ignoredK8sEnv)

  // Pool-teardown debris (watchdog swap) must degrade to a warn, not kill the
  // api process. See db/connection.ts.
  installPgTeardownRejectionGuard()
  // Set up WebSocket event bridge
  setupEventBridge(wsManager)

  // In Kubernetes, bind to all interfaces so pod-IP readiness/liveness probes
  // and other pods can reach the API. Otherwise default to localhost for security.
  const isRunningInK8s = isK8sRuntime() || !!process.env.KUBERNETES_SERVICE_HOST
  const host = apiBindHost(process.env, isRunningInK8s)
  const port = Number(process.env.PORT) || 3000

  // Point the cross-process event transport at ficus-worker's loopback listener.
  // Done before the boot chain so the very first secret write or emitted event
  // already forwards (the peer being down is a logged no-op, not an error).
  configureLocalEvents('api')

  // Ensure home data directory exists
  ensureHomeDir()

  // Ensure session data directory exists
  ensureSessionDataDir()

  // Validate and cache system log configuration without preventing Core startup.
  initializeSystemLogProvider()

  // Wait for database and run migrations, then initialize secrets and sync definitions
  waitForDbAndMigrate()
    .catch((error) => {
      log.error('Failed to wait for database and migrate:', error)
      process.exit(1)
    })
    .then(async () => {
      const reconciled = await reconcileKeylessAmtpRegistrations()
      if (reconciled.length > 0) log.warn('[api] Closed historical keyless AMTP registrations', reconciled)

      const { maintenanceStore } = await import('./services/maintenance')
      await maintenanceStore.initialize()

      // Crash recovery for box migration fences — run in THIS process because
      // migrations execute HERE: routes/machines.ts (mounted below) calls
      // migrateBox/rebalanceFleet directly, so an API crash mid-migrate is what
      // leaves an orphaned fence (which defers every queued turn for the box's
      // owners indefinitely — the worker only defers on fences, never clears
      // them). Memoized-once: the migrate/rebalance routes await the SAME
      // barrier before executing, so a request served before this chain runs
      // (Bun.serve accepts before boot finishes) performs the recovery itself —
      // this boot step can never clear a fence a request-side migrate holds.
      // Non-fatal on failure: the barrier un-memoizes and retries on the first
      // migrate/rebalance request.
      try {
        const { recoverMigrationFencesOnce } = await import('./services/machines/queries')
        const staleFences = await recoverMigrationFencesOnce()
        if (staleFences > 0) {
          log.info(`Cleared ${staleFences} stale box migration fence(s) left by a previous api crash`)
        }
      } catch (error) {
        log.warn('Box migration fence recovery failed at boot (will retry before the first migrate):', error)
      }

      const { getSecretStore, SECRET_STORE_REFRESH_INTERVAL_MS } = await import('./services/secrets')
      const store = getSecretStore()
      await store.initialize()
      // Both processes refresh authoritative DB state periodically so missed
      // local-events invalidations self-heal. Immediate key invalidation remains
      // the fast path and is wired only after the refresh runner is owned.
      store.startPeriodicRefresh(SECRET_STORE_REFRESH_INTERVAL_MS)
      await store.startCrossProcessInvalidation()
      const [{ setLogContentSanitizer }, { getContentSafetyRegistry }] = await Promise.all([
        import('./lib/infra/logger'),
        import('./services/security/content-safety-registry'),
      ])
      setLogContentSanitizer((args) => getContentSafetyRegistry().redact(args))

      // Ensure VAPID keys exist (must be after secret store init)
      await getVapidKeys()

      // Ensure the sandbox callback secret exists (used by the in-cluster watcher).
      const { ensureSandboxCallbackSecret } = await import('./services/auth/sandbox-secret')
      await ensureSandboxCallbackSecret()

      // The API is a settings/provider-health read replica. Cross-process
      // invalidation is the fast path; periodic refresh bounds missed events.
      const settingsStore = getSettingsStore()
      await settingsStore.initialize()
      const { initializeChannelIntegrationStates } = await import('./services/integrations/channels/settings')
      await initializeChannelIntegrationStates()
      const { initializeDeploymentIntegrationStates } = await import('./services/integrations/deployment/settings')
      await initializeDeploymentIntegrationStates()
      const { initializeGoogleCloudIntegrationState } = await import('./services/integrations/google-cloud/settings')
      await initializeGoogleCloudIntegrationState()
      await initializeOpenAIServicesState()
      const { initializePushIntegrationStates } = await import('./services/integrations/push/settings')
      await initializePushIntegrationStates()
      const { providerHealth, PROVIDER_HEALTH_STATE_KEY } = await import('./services/provider-health/registry')
      providerHealth.disablePersistence()
      await providerHealth.hydrateFromPersistence()
      settingsStore.startPeriodicRefresh(SETTINGS_STORE_REFRESH_INTERVAL_MS, () =>
        providerHealth.hydrateFromPersistence()
      )
      await settingsStore.startCrossProcessInvalidation()

      // Channel connections: the transports read a snapshot; provider-side
      // setup (Telegram webhook, Discord slash commands, the gateway) follows
      // it. Refresh on the provider switches, after local saves, and on a timer.
      const { channelConnections } = await import('./services/integrations/channels/connections')
      const { ChannelLifecycle } = await import('./services/integrations/channels/lifecycle')
      const { isChannelEnabledSettingKey } = await import('./services/integrations/channels/settings')
      const channelLifecycle = new ChannelLifecycle({
        connections: channelConnections,
        onDiscordChange: () => {
          stopDiscordGateway()
          startDiscordGateway()
        },
      })
      channelConnections.onChange(() => channelLifecycle.reconcile())
      await channelConnections.refresh()
      const { createPeriodicRunner } = await import('./lib/infra/PeriodicRunner')
      createPeriodicRunner({
        name: 'channel-connections-refresh',
        intervalMs: 30_000,
        task: () => channelConnections.refresh(),
      }).start()

      settingsStore.onChange(async (key) => {
        if (isChannelEnabledSettingKey(key)) await channelConnections.refresh()
        if (key === PROVIDER_HEALTH_STATE_KEY) await providerHealth.hydrateFromPersistence()
      })

      // Warm the offline ModelRuntime after secrets/settings are ready so
      // synchronous status/model-selection paths can see env-var-only auth.
      const { warmModelRuntimeForStartup } = await import('./services/agent/auth-backend')
      await warmModelRuntimeForStartup()
    })
    .catch((error) => {
      log.error('Failed to initialize secret store:', error)
      process.exit(1)
    })
    .then(() => syncAllConfig())
    .catch((error) => {
      log.error('Failed to sync config:', error)
      process.exit(1)
    })
    .then(async () => {
      runSandboxSetupValidation()
      if (isHostRuntime()) {
        const { hydrateHostWorkspaceOverrides } = await import('./services/sandbox/host/workspace-overrides-hydrate')
        try {
          log.info(`Host runtime: loaded ${await hydrateHostWorkspaceOverrides()} squad workspace override(s)`)
        } catch (err) {
          // Fatal by design (an un-hydrated cache silently sends every squad to
          // its storage workspace instead of the configured directory), but the
          // most likely cause is a specific, fixable one — say so before dying.
          log.error(
            'Host runtime: could not load squad workspace overrides (is migration 0147_host_workspace_path applied?)'
          )
          throw err
        }
      }
    })
    .then(() => {
      void (async () => {
        try {
          const { warmupActiveSquadSandboxes } = await import('./services/sandbox/squad-warmup')
          await warmupActiveSquadSandboxes(log)
        } catch (err) {
          log.warn('Squad sandbox warmup failed:', err)
        }
        try {
          const { warmupWorkStreamAgentSandboxes } = await import('./services/sandbox/work-stream-warmup')
          await warmupWorkStreamAgentSandboxes(log)
        } catch (err) {
          log.warn('Work-stream agent sandbox warmup failed:', err)
        }
      })()
    })
    .then(async () => {
      // Initialize webhook processors and handlers
      initializeWebhooks()

      // Load webhook action config
      const webhookActionsPath = join(WEBHOOKS_DIR, 'actions.yaml')
      try {
        const actionConfig = await loadWebhookActionConfig(webhookActionsPath)
        setGithubActionConfig(actionConfig)
        setLinearActionConfig(actionConfig)
        log.info('Webhook action config loaded')
      } catch (error) {
        log.warn('Failed to load webhook action config:', error)
      }

      // Initialize distributed event emitter over the loopback HTTP transport
      eventEmitter.initialize('api', notify)
      await eventEmitter.startListening(listen)

      // Register notification service with event emitter
      notificationService.register(eventEmitter)
      log.info('Notification service initialized')

      // Register thread indexer events (indexes agent threads on execution complete)
      registerThreadIndexerEvents()

      // Start core boot subsystems in order (worker health monitor, external
      // source reindex runner, local update scheduler, auth cleanup scheduler,
      // periodic-runner catch-all, discord gateway) — see `subsystems` above.
      await startSubsystems(subsystems, log)

      // Start embedding worker only if enabled
      const settingsStore = getSettingsStore()
      const embeddingsEnabled = settingsStore.getTyped('EMBEDDINGS_ENABLED') as boolean
      const hasApiKey = !!getOpenAIServiceKey()
      if (embeddingsEnabled && hasApiKey) {
        EmbeddingWorker.instance().start()
      } else {
        log.info(`Embedding worker not started (enabled=${embeddingsEnabled}, hasApiKey=${hasApiKey})`)
      }

      // React to settings changes
      settingsStore.onChange(async (key) => {
        if (key === 'EMBEDDINGS_ENABLED' || key === OPENAI_SERVICES_ENABLED_KEY) {
          const enabled = settingsStore.getTyped('EMBEDDINGS_ENABLED') as boolean
          const hasKey = !!getOpenAIServiceKey()
          if (enabled && hasKey) {
            log.info('Embeddings enabled — starting worker')
            EmbeddingWorker.instance().start()
          } else {
            log.info('Embeddings disabled — stopping worker')
            await EmbeddingWorker.instance().stop()
          }
        }
      })

      // React to API key changes. Legacy chat-bot keys flow through the
      // channel snapshot (the lifecycle restarts the Discord gateway on a
      // revision change), so refresh it rather than restarting here.
      const { channelConnections, isLegacyChannelCredentialKey } =
        await import('./services/integrations/channels/connections')
      getSecretStore().onChange(async (key) => {
        if (isLegacyChannelCredentialKey(key)) await channelConnections.refresh()
        await regenerateEnvFilesForSecretKey(key)

        if (key === 'OPENAI_API_KEY') {
          const enabled = settingsStore.getTyped('EMBEDDINGS_ENABLED') as boolean
          // Reset EmbeddingService singleton so it picks up new key
          const { EmbeddingService } = await import('./services/memory/indexer/EmbeddingService')
          EmbeddingService._reset()
          if (enabled && getOpenAIServiceKey()) {
            log.info('OpenAI API key set — starting embedding worker')
            EmbeddingWorker.instance().start()
          } else {
            log.info('OpenAI API key removed — stopping embedding worker')
            await EmbeddingWorker.instance().stop()
          }
        }
      })

      // React to onboarding-affecting changes: this process's own SecretStore
      // cache (GitHub/Slack/Discord token changes) plus squad.created/archived
      // (provider-account changes go through account-store.ts's own chokepoint
      // directly). See services/onboarding/events.ts.
      registerOnboardingEventSources()

      const { ensureSandboxesForLiveManagedLocalDeployments } =
        await import('./services/deploy/local-deployment-health')

      // On API startup, auto-start sandboxes for managed localDeployments that should be live.
      ensureSandboxesForLiveManagedLocalDeployments().catch((err) => {
        log.error('Failed to ensure sandboxes for live managed localDeployments:', err)
      })

      // In K8s mode, check cluster connectivity and reconcile pods
      if (isK8sRuntime()) {
        const manager = getSandboxManager() as import('./services/sandbox/k8s/manager').K8sSandboxManager
        const clusterOk = await manager.podManager.checkClusterConnectivity()
        if (clusterOk) {
          manager.reconcileSquadPods()
          // Warm the node image cache in the background so the first sandbox
          // creation doesn't pay the layer-pull cost. Fire-and-forget — never
          // blocks boot, best-effort.
          void manager.podManager
            .prepullImages()
            .catch((err) => log.warn('Sandbox image pre-pull failed (non-fatal):', err))
        }
      } else if (isVmRuntime()) {
        // In VM mode, boxes need at least one registered, ready machine to land on.
        // Report the count and WARN (not fail) when zero — a machine may be
        // registered later, and only the first sandbox creation actually needs one.
        try {
          const { listMachines } = await import('./services/machines/queries')
          const ready = (await listMachines()).filter((m) => m.status === 'ready')
          if (ready.length === 0) {
            log.warn('VM sandbox runtime: no ready machines registered; sandboxes cannot start until one is registered')
          } else {
            log.info(`VM sandbox runtime: ${ready.length} ready machine(s) available`)
          }
        } catch (err) {
          log.warn('VM sandbox runtime: failed to query ready machines:', err)
        }
      }
    })
    .then(() => readiness.markReady())
    .catch((error) => {
      log.error('Failed to initialize:', error)
      process.exit(1)
    })

  // Subscribe to archival events to clean up terminal sessions
  eventEmitter.on('squad.archived', ({ squadId }) => {
    terminalManager.killSandboxSessions(Squad.getSandboxId(squadId))
  })

  // Add graceful shutdown handling
  const gracefulShutdown = async (signal: string) => {
    readiness.markStopping()
    log.info(`Received ${signal}, shutting down...`)
    await stopSubsystems(subsystems, log)
    terminalManager.cleanup()
    await getSandboxManager().cleanup()
    process.exit(0)
  }
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'))
  process.on('SIGINT', () => gracefulShutdown('SIGINT'))

  log.info(`Running on http://${host}:${port}`)

  Bun.serve({
    hostname: host,
    port,
    fetch(request, server) {
      attachPeerAddress(request, server.requestIP(request)?.address)
      // Bun calls this with (request, server); Hono's bun adapter reads the server
      // out of `c.env` to perform WebSocket upgrades (`getBunServer`). Passing only
      // `request` leaves env undefined and every upgrade throws
      // `c.env is not an Object`. #870 introduced this when it replaced the bare
      // `fetch: app.fetch` — which Bun invoked with both arguments — with this
      // wrapper for peer-address capture.
      return app.fetch(request, server)
    },
    websocket,
    // Every route but the local-app proxy: that one extends its own requests
    // (LOCAL_APP_PROXY_IDLE_TIMEOUT_SECONDS) so a slow app can still answer.
    idleTimeout: 30,
  })
}
