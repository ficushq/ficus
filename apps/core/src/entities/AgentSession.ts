import {
  createAgentSession,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  ToolDefinition,
  getLatestCompactionEntry,
  type AgentSession as PiAgentSession,
} from '@earendil-works/pi-coding-agent'
import { parseModelSpec, resolveAgentModelSpec } from '../lib/utils/model-spec'
import { selectModelSpecForCurrentEnvWithSwitchBack, type SwitchBackInfo } from '../services/model-selection'
import { classifyResponseHeaders } from '../services/provider-health/header-signal'
import { providerHealth } from '../services/provider-health/registry'
import { setAgentSelectedModel } from './Agent'
import { resolveWorkspaceLayout } from '../services/sandbox/workspace-layout'
import { TauResourceLoader } from '../services/agent'
import {
  AccountScopedCredentialStore,
  createAccountScopedCredentialStore,
} from '../services/agent/account-auth-backend'
import { registerOpenAICompatibleAccounts } from '../services/agent/auth-backend'
import { selectAccount } from '../services/agent/account-selection'
import * as accountStore from '../services/agent/account-store'
import { AGENT_DIR } from '../lib/paths'
import { openOrCreateSession } from '../lib/infra/session-files'
import { routeDecision, SessionUsage } from '@ficus/shared'
import { filterToolsByPolicy } from '../lib'
import { getContentSafetyRegistry } from '../services/security/content-safety-registry'
import { wrapToolsWithOutputRedaction, type OnStoredToolResult } from '../services/security/tool-output-redaction'
import { PrecompactionController, type PrecompactionDeps } from '../services/agent/precompaction/controller'
import {
  createFitCompactionFallback,
  createPiCompactionBaker,
  type PiCompactionBakerOptions,
} from '../services/agent/precompaction/baker'
import { resolveEarlyMarginTokens, resolveInFlightMarginTokens } from '../services/agent/precompaction/config'
import { bindPrecompactionController } from '../services/agent/precompaction/registry'
import { ShortTermMemoryContext } from '../services/agent/short-term-memory-context'
import { getShortTermMemory } from '../tools/short-term-memory'
import { createLogger } from '../lib/infra/logger'

export interface CreateAgentSessionOptions {
  /** Model. Format: provider:model-name[:thinking-level] (e.g. 'anthropic:claude-sonnet-4-5:high') */
  model: string
  /** The storage settings for the session. If not provided, the session will be
   * ephemeral. */
  storage?: { agentId: string }
  /**
   * The agent's currently-persisted `selectedModel`, used as a sticky
   * preference for proactive switch-back. Omit for fresh agents (normal eager
   * selection).
   */
  currentSelectedModel?: string
  /** System prompt. */
  systemPrompt: string
  /** Paths to skill folders on the host. */
  skillPaths?: string[]
  /** Paths to extension folders on the host. */
  extensionPaths?: string[]
  /** Early pre-compaction margin in tokens. Null/undefined uses the default; <=0 disables. */
  earlyMarginTokens?: number | null
  /** In-flight/mid-turn pre-compaction margin in tokens. Null/undefined uses the default; <=0 disables. */
  inFlightMarginTokens?: number | null
  /**
   * Whether to wire the background pre-compaction controller (default true).
   * Set false for throwaway sessions created only to run a one-shot compaction,
   * so creating them never spuriously starts (and immediately aborts) a bake.
   */
  precompaction?: boolean
  /** Tools. */
  tools?: {
    /** Tools that are always included, regardless of filter. */
    core?: ToolDefinition[]
    /** Available tools that can be filtered by name via the allowlist and denylist. */
    available?: ToolDefinition[]
    /** Allowlist of tool names to include from available tools. If not provided, all available tools are included. */
    allow?: string[] | null
    /** Denylist of tool names to exclude from available tools. If not provided, no tools are excluded. */
    deny?: string[] | null
  }
  /** Sandbox configuration */
  sandbox?: {
    /** Sandbox ID */
    sandboxId: string
    /** Workspace path on the host (used as Docker mount source). */
    workspacePath: string
    /** Squad this sandbox belongs to (drives namespaced cwd). */
    squadId?: string
  }
  /**
   * Observes stored-value matches in tool result content after the original
   * tool executed, alongside the inbound redaction boundary. Agent-execution
   * sessions pass the runner's containment coordinator callback; other
   * callers omit it and keep redaction-only behavior.
   */
  onStoredToolResult?: OnStoredToolResult
}

export class AgentSession {
  public precompaction?: PrecompactionController

  constructor(
    public readonly pi: PiAgentSession,
    public selectedSpec?: string,
    public readonly switchedBack?: SwitchBackInfo,
    public readonly authBackend?: AccountScopedCredentialStore,
    public accountId?: string
  ) {}

  attachPrecompaction(controller: PrecompactionController): void {
    this.precompaction = controller
  }

  dispose(): void {
    // The controller's lifetime is owned by the precompaction registry, NOT the
    // session — a background bake must survive this per-turn teardown. Only drop
    // our reference; eviction happens on reset/terminate/delete/LRU/idle.
    this.precompaction = undefined
  }

  static async create({
    model: modelId,
    storage,
    systemPrompt,
    skillPaths,
    extensionPaths,
    earlyMarginTokens,
    inFlightMarginTokens,
    precompaction: enablePrecompaction = true,
    tools,
    sandbox,
    currentSelectedModel,
    onStoredToolResult,
  }: CreateAgentSessionOptions): Promise<AgentSession> {
    const { selected, switchedBack } = selectModelSpecForCurrentEnvWithSwitchBack(modelId, currentSelectedModel)
    const { model, thinkingLevel } = resolveAgentModelSpec(selected)

    // Persist the actually-selected model (best-effort, non-blocking) for
    // display. A priority list may resolve to a different candidate than the
    // configured model priority list; recording it keeps the UI accurate.
    if (storage?.agentId) {
      void setAgentSelectedModel(storage.agentId, selected).catch(() => {})
    }
    // Redact stored secrets out of tool results before the model reads them.
    // This is the security boundary: nothing downstream re-redacts, because
    // anything the agent authored is the operator's own data.
    const customTools = wrapToolsWithOutputRedaction(
      [...(tools?.core ?? []), ...filterToolsByPolicy(tools?.available ?? [], tools?.allow, tools?.deny)],
      getContentSafetyRegistry(),
      onStoredToolResult
    )

    const resourceLoader = await TauResourceLoader.create(systemPrompt, skillPaths, extensionPaths)
    const sessionManager = storage
      ? // If storage is provided, use the session manager for the agent ID and sandbox workspace path. If no sandbox, it will just use the session directory, which is fine—it shouldn't be used for anything.
        openOrCreateSession(storage.agentId, sandbox?.workspacePath)
      : // If no storage, use ephemeral in-memory session manager.
        SessionManager.inMemory()
    const settingsManager = SettingsManager.inMemory({
      retry: { enabled: true, maxRetries: 5 },
      // Steers should interrupt as a complete batch at the next drain point,
      // while follow-ups should continue to run one turn at a time.
      steeringMode: 'all',
      followUpMode: 'one-at-a-time',
    })

    const provider = parseModelSpec(selected).provider
    const { credentials, backend: authBackend } = createAccountScopedCredentialStore([provider])
    const accountId = authBackend.getSelectedAccountId(provider)
    const modelRuntime = await ModelRuntime.create({
      credentials,
      allowModelNetwork: false,
    })
    registerOpenAICompatibleAccounts(modelRuntime)

    const { session } = await createAgentSession({
      // Used in SettingsManager, SessionManager, and DefaultResourceLoader, all
      // of which we override with our own. So this only affects the Pi
      // AgentSession instance, which uses it for extensions (which we don't
      // use), base tools (which we override), and the system prompt (appended
      // to the end). So all it really does is tell the agent what the CWD is,
      // which we want to be the workspace path.
      cwd: sandbox
        ? resolveWorkspaceLayout({ squadId: sandbox.squadId, sandboxId: sandbox.sandboxId }).cwd
        : process.cwd(),
      // This is used for the model runtime, model registry, and settings
      // files.
      agentDir: AGENT_DIR,
      modelRuntime,
      model,
      thinkingLevel: thinkingLevel ?? 'medium',
      // Disable built-in tools.
      noTools: 'builtin',
      // Add custom tools.
      customTools,
      resourceLoader,
      sessionManager,
      settingsManager,
    })

    const wrapper = new AgentSession(session, selected, switchedBack, authBackend, accountId)

    if (storage) {
      const memoryContext = new ShortTermMemoryContext(
        session.sessionManager,
        () => getShortTermMemory(storage.agentId),
        (error) => createLogger('short-term-memory').warn('Could not capture recovery snapshot', error)
      )
      resourceLoader.setShortTermMemoryContext(memoryContext)
      await memoryContext.captureInitial()
    }

    let precompaction: PrecompactionController | undefined
    const bakerOptions: PiCompactionBakerOptions = storage
      ? {
          modelFailover: {
            priorityList: modelId,
            getActiveAccountId: () => wrapper.accountId,
            prepareProviderSwitch: (nextProvider) => {
              const store = accountStore.readAccountStore()
              const accounts = accountStore.listAccounts(store, nextProvider)
              const previousAccountId = authBackend.getSelectedAccountId(nextProvider)
              const previousWrapperAccountId = wrapper.accountId
              const rollback = () => {
                if (previousAccountId) authBackend.selectAccount(nextProvider, previousAccountId)
                else authBackend.clearAccount(nextProvider)
                wrapper.accountId = previousWrapperAccountId
              }

              // Stored-account providers must have a healthy account before they
              // are candidates. Env-only providers have no stored accounts, so
              // leave auth projection untouched and let getAuth decide.
              if (accounts.length > 0) {
                const nextAccount = selectAccount(nextProvider, store, {
                  isAccountHealthy: (p, accountId) =>
                    routeDecision({ provider: p, accountId }, providerHealth.snapshotRecords(), Date.now()).state ===
                    'ready',
                })
                if (!nextAccount) return false

                authBackend.selectAccount(nextProvider, nextAccount.id)
                return {
                  accountId: nextAccount.id,
                  commit: () => {
                    wrapper.accountId = nextAccount.id
                    stampAccountLastUsed(nextProvider, nextAccount.id)
                  },
                  rollback,
                }
              }

              authBackend.clearAccount(nextProvider)
              return {
                commit: () => {
                  wrapper.accountId = undefined
                },
                rollback,
              }
            },
            onModelSwitched: (_nextProvider, nextSpec) => {
              wrapper.selectedSpec = nextSpec
              void setAgentSelectedModel(storage.agentId, nextSpec).catch(() => {})
            },
          },
        }
      : {}
    // Fit fallback is wired unconditionally: ephemeral sessions and
    // `precompaction: false` one-shot sessions still hit the
    // session_before_compact hook and can overflow a small summarizer (#625).
    resourceLoader.setFitCompactionFallback(createFitCompactionFallback(session, bakerOptions))
    if (storage && enablePrecompaction) {
      const deps = buildPrecompactionDeps(session, earlyMarginTokens, inFlightMarginTokens, bakerOptions)
      precompaction = bindPrecompactionController(storage.agentId, deps)
      if (precompaction) resourceLoader.setPrecompactionController(precompaction)
    }

    // Proactively mark the active provider/account exhausted from response headers
    // (429 / near-zero remaining / retry-after) before an error surfaces. The
    // active provider is resolved from the wrapper's current selected spec so
    // the signal still lands on the right registry entry after model failover.
    try {
      wrapAgentOnResponseForHealth(session, (provider) => authBackend.getSelectedAccountId(provider))
    } catch {
      // selected is always a valid spec here, but guard anyway so a parse
      // failure can never block session creation.
    }
    if (precompaction) wrapper.attachPrecompaction(precompaction)
    return wrapper
  }

  /**
   * Capture session usage.
   */
  captureUsage(): SessionUsage {
    const stats = this.pi.getSessionStats()
    const context = this.pi.getContextUsage()
    return {
      stats: {
        userMessages: stats.userMessages,
        assistantMessages: stats.assistantMessages,
        totalMessages: stats.totalMessages,
        tokens: stats.tokens,
        cost: stats.cost,
      },
      context: context
        ? { tokens: context.tokens ?? 0, contextWindow: context.contextWindow, percent: context.percent ?? 0 }
        : null,
    }
  }
}

/** Stamp lastUsedAt on an account through the serialized mutate queue. */
function stampAccountLastUsed(provider: string, accountId: string): void {
  accountStore
    .mutateAccountStore((store) => {
      const account = accountStore.getAccount(store, provider, accountId)
      if (!account) return false
      account.lastUsedAt = Date.now()
      return true
    }, 'system')
    .catch(() => {})
}

/**
 * Build PrecompactionController deps from a pi session. Exported for focused
 * unit tests; runtime wiring lives in AgentSession.create.
 */
export function buildPrecompactionDeps(
  pi: PiAgentSession,
  earlyMarginTokens: number | null | undefined,
  inFlightMarginTokens: number | null | undefined,
  bakerOptions?: PiCompactionBakerOptions
): PrecompactionDeps {
  const baker = createPiCompactionBaker(pi, bakerOptions)

  return {
    getContextUsage: () => {
      const usage = pi.getContextUsage()
      return usage ? { tokens: usage.tokens ?? 0, contextWindow: usage.contextWindow } : undefined
    },
    getCompactionSettings: () => pi.settingsManager.getCompactionSettings(),
    isCompacting: () => pi.isCompacting,
    snapshot: () => {
      const entries = pi.sessionManager.getBranch()
      const latest = getLatestCompactionEntry(entries)
      return {
        entries,
        latestCompactionEntryId: latest ? ((latest as { id?: string }).id ?? null) : null,
      }
    },
    getModelKey: () => {
      const model = pi.model
      return model ? `${model.provider}/${model.id}/${model.contextWindow}` : undefined
    },
    bake: baker,
    marginTokens: resolveEarlyMarginTokens(earlyMarginTokens),
    inFlightMarginTokens: resolveInFlightMarginTokens(inFlightMarginTokens),
  }
}

/**
 * Wrap the Pi Agent stream function so each network request captures an
 * immutable provider/account attempt before dispatch. Its response hook then
 * attributes proactive header signals through that token even if live session
 * selection changes while the request is in flight.
 *
 * The health-signal computation is wrapped in try/catch so a parsing failure
 * can never break the response stream; the previous handler is then invoked
 * with its original semantics preserved.
 */
export function wrapAgentOnResponseForHealth(
  session: PiAgentSession,
  getRequestAccountId?: (provider: string) => string | undefined
): void {
  const agent = session.agent
  const stream = agent.streamFunction
  agent.streamFunction = (model, context, options) => {
    const attempt = providerHealth.captureAttempt(model.provider, getRequestAccountId?.(model.provider))
    const onResponse = options?.onResponse
    return stream(model, context, {
      ...options,
      onResponse: async (response, responseModel) => {
        try {
          const signal = classifyResponseHeaders(response.status, response.headers)
          if (signal) {
            providerHealth.recordFailure(attempt, {
              kind: signal.reason,
              retryAt: signal.retryAt,
              status: signal.status,
            })
          }
        } catch {
          // Health signal must never break the response stream.
        }
        if (onResponse) await onResponse(response, responseModel)
      },
    })
  }
}
