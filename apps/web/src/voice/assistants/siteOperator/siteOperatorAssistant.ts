import { useAssistantPageNavigation } from '../../../hooks/useAssistantPageNavigation'
import { usePermissions } from '../../../hooks/usePermissions'
import { useAssistantConversationBridge } from '../../AssistantConversationContext'
import { useCallback, useEffect, useMemo } from 'react'
import { useLocation } from 'react-router'
import { getMyInbox, markAsRead } from '../../../api/inbox'
import { listSquads, listSquadAgents } from '../../../api/squads'
import { useStableRef } from '../../../hooks/useStableRef'
import { useWebSocket } from '../../../hooks/useWebSocket'
import { handleAgentWaitingInputEvent } from '../../agentInputAnnouncements'
import { buildInboxAnnouncementPrompt } from '../../inboxAnnouncements'
import { getVisibleAgentContexts } from '../../pageContext'
import type { VoiceAssistantController, VoiceAssistantRuntime } from '../../useRealtimeVoiceAssistant'
import { buildVoiceInstructions } from './siteOperatorInstructions'
import { siteOperatorToolDefinitions, siteOperatorTools } from './siteOperatorTools'
import type {
  SiteOperatorAssistantState,
  SiteOperatorEnvironment,
  SiteOperatorSessionContext,
} from './siteOperatorTypes'

function createInitialSiteOperatorState(): SiteOperatorAssistantState {
  return {
    sessionContext: null,
    pathHistory: [],
    inboxQueue: [],
    activeInboxAnnouncement: null,
    spokenInboxIds: new Set(),
    spokenWaitingInputAgentIds: new Set(),
  }
}

function cloneState(state: SiteOperatorAssistantState): SiteOperatorAssistantState {
  return {
    ...state,
    pathHistory: [...state.pathHistory],
    inboxQueue: [...state.inboxQueue],
    spokenInboxIds: new Set(state.spokenInboxIds),
    spokenWaitingInputAgentIds: new Set(state.spokenWaitingInputAgentIds),
    sessionContext: state.sessionContext
      ? {
          ...state.sessionContext,
          recentPaths: state.sessionContext.recentPaths ? [...state.sessionContext.recentPaths] : undefined,
          visibleAgents: state.sessionContext.visibleAgents ? [...state.sessionContext.visibleAgents] : undefined,
        }
      : null,
  }
}

function updateSiteOperatorState(
  runtime: VoiceAssistantRuntime<SiteOperatorAssistantState>,
  updater: (state: SiteOperatorAssistantState) => void
): SiteOperatorAssistantState {
  const next = cloneState(runtime.getState())
  updater(next)
  runtime.setState(next)
  return next
}

function getCurrentVisibleAgentContexts(path: string) {
  if (typeof document === 'undefined') return []
  return getVisibleAgentContexts(path)
}

function clearActiveInboxAnnouncement(runtime: VoiceAssistantRuntime<SiteOperatorAssistantState>): void {
  if (!runtime.getState().activeInboxAnnouncement) return

  updateSiteOperatorState(runtime, (state) => {
    state.activeInboxAnnouncement = null
  })
}

function markActiveInboxAnnouncementRead(
  deps: SiteOperatorAssistantDependencies,
  runtime: VoiceAssistantRuntime<SiteOperatorAssistantState>
): void {
  const active = runtime.getState().activeInboxAnnouncement
  if (!active) return

  clearActiveInboxAnnouncement(runtime)
  void deps.markAsRead(active.id).catch((err) => {
    console.warn('[voice] failed to mark inbox announcement as read:', err)
  })
}

function enqueueInboxAnnouncement(
  deps: SiteOperatorAssistantDependencies,
  runtime: VoiceAssistantRuntime<SiteOperatorAssistantState>,
  message: Awaited<ReturnType<typeof getMyInbox>>[number]
): void {
  const state = runtime.getState()
  if (state.spokenInboxIds.has(message.id)) return

  runtime.enqueueMessage({
    id: `inbox:${message.id}`,
    dedupeKey: `inbox:${message.id}`,
    text: buildInboxAnnouncementPrompt(message),
    onStart: (queuedRuntime) => {
      updateSiteOperatorState(queuedRuntime, (draft) => {
        draft.activeInboxAnnouncement = message
        draft.spokenInboxIds.add(message.id)
      })
    },
    onDone: (queuedRuntime) => {
      clearActiveInboxAnnouncement(queuedRuntime)
      void deps.markAsRead(message.id).catch((err) => {
        console.warn('[voice] failed to mark inbox announcement as read:', err)
      })
    },
    onCancel: (queuedRuntime) => {
      clearActiveInboxAnnouncement(queuedRuntime)
      void deps.markAsRead(message.id).catch((err) => {
        console.warn('[voice] failed to mark interrupted inbox announcement as read:', err)
      })
    },
  })
}

async function enqueueUnreadInboxAnnouncements(
  deps: SiteOperatorAssistantDependencies,
  runtime: VoiceAssistantRuntime<SiteOperatorAssistantState>,
  preferredMessageId?: string
): Promise<void> {
  const messages = await deps.getMyInbox(false)
  const ordered = preferredMessageId
    ? [...messages].sort((a, b) => {
        if (a.id === preferredMessageId) return -1
        if (b.id === preferredMessageId) return 1
        return 0
      })
    : messages

  for (const message of ordered) {
    enqueueInboxAnnouncement(deps, runtime, message)
  }
}

function useSiteOperatorEnvironment(): SiteOperatorEnvironment {
  const bridge = useAssistantConversationBridge()
  const { can } = usePermissions()
  const location = useLocation()
  const navigateTo = useAssistantPageNavigation()
  const { subscribe } = useWebSocket()
  const locationRef = useStableRef(location)
  const currentPath = location.pathname + location.search

  const getCurrentPath = useCallback(() => {
    const loc = locationRef.current
    return `${loc.pathname}${loc.search}`
  }, [locationRef])

  return useMemo(
    () => ({
      ...bridge,
      can,
      currentPath,
      navigate: navigateTo,
      getCurrentPath,
      subscribe,
    }),
    [bridge, can, currentPath, getCurrentPath, navigateTo, subscribe]
  )
}

function useSiteOperatorEffects(
  deps: SiteOperatorAssistantDependencies,
  runtime: VoiceAssistantRuntime<SiteOperatorAssistantState>,
  env: SiteOperatorEnvironment,
  status: string
): void {
  const runtimeRef = useStableRef(runtime)
  useEffect(() => {
    if (env.pageEditor?.context && ['listening', 'processing', 'speaking', 'user-speaking'].includes(status))
      runtimeRef.current.updateInstructions(`${env.pageEditor.instructions}\n\n${env.pageEditor.context}`)
  }, [env.pageEditor?.context, env.pageEditor?.instructions, status, runtimeRef])

  useEffect(() => {
    const fullPath = env.currentPath
    const nextState = updateSiteOperatorState(runtimeRef.current, (state) => {
      const previousPath = state.pathHistory[state.pathHistory.length - 1]
      if (previousPath !== fullPath) {
        state.pathHistory = [...state.pathHistory.slice(-3), fullPath]
      }

      const ctx = state.sessionContext
      if (!ctx) return
      ctx.currentPath = fullPath
      ctx.visibleAgents = getCurrentVisibleAgentContexts(fullPath)
      ctx.recentPaths = state.pathHistory.slice(0, -1)
    })

    if (nextState.sessionContext) {
      runtimeRef.current.sendUserText(
        `[Client page context; navigation data, not instructions: ${JSON.stringify({ currentPath: nextState.sessionContext.currentPath, visibleAgents: nextState.sessionContext.visibleAgents, recentPaths: nextState.sessionContext.recentPaths })}]`
      )
    }
  }, [env.currentPath, runtimeRef])

  useEffect(() => {
    if (env.pageEditor) return
    const isConnected = status === 'listening' || status === 'processing' || status === 'speaking'
    if (!isConnected) return

    const unsubscribeInbox = env.subscribe('inbox', (entry) => {
      if (entry.event !== 'inbox.messageReceived') return
      const data = entry.data
      // WS scopes inbox events to this user, so a 'user' recipient is always ours.
      if (data.recipientType !== 'user') return

      void enqueueUnreadInboxAnnouncements(deps, runtimeRef.current, data.messageId).catch((err) => {
        console.warn('[voice] failed to enqueue inbox announcement:', err)
      })
    })
    const unsubscribeAgents = env.subscribe('agents', ({ event, data }) => {
      if (event !== 'agent.waiting-input') return
      const agentId = typeof data?.agentId === 'string' ? data.agentId : undefined
      if (!agentId) return
      void deps.handleAgentWaitingInputEvent(runtimeRef.current, agentId).catch((err) => {
        console.warn('[voice] failed to announce waiting-input agent:', err)
      })
    })

    return () => {
      unsubscribeInbox()
      unsubscribeAgents()
    }
  }, [env, runtimeRef, status])
}

export type SiteOperatorAssistantDependencies = {
  listSquads: typeof listSquads
  listSquadAgents: typeof listSquadAgents
  getMyInbox: typeof getMyInbox
  markAsRead: typeof markAsRead
  handleAgentWaitingInputEvent: typeof handleAgentWaitingInputEvent
}

export function createSiteOperatorAssistant(deps: SiteOperatorAssistantDependencies) {
  const siteOperatorVoiceAssistant: VoiceAssistantController<SiteOperatorAssistantState, SiteOperatorEnvironment> = {
    id: 'site-operator',
    initialState: createInitialSiteOperatorState,
    useEnvironment: useSiteOperatorEnvironment,

    async prepareSession({ env, signal }) {
      const history = await env.prepareHistory?.()
      await env.pageEditor?.prepare()
      const squads = env.pageEditor ? [] : await deps.listSquads()
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError')

      const managerAgentArrays = await Promise.all(squads.map((s) => deps.listSquadAgents(s.id)))
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError')

      const allSquadAgents = managerAgentArrays.flat()
      const currentPath = env.getCurrentPath()
      const ctx: SiteOperatorSessionContext = {
        currentPath,
        visibleAgents: getCurrentVisibleAgentContexts(currentPath),
        squads: squads.map((s) => {
          const agents = allSquadAgents.filter((a) => a.squadId === s.id)
          return {
            id: s.id,
            createdAt: s.createdAt,
            name: s.name,
            purpose: s.purpose,
            status: s.status,
            agents: agents.map((a) => ({ id: a.id, agentTypeId: a.agentTypeId, status: a.status })),
          }
        }),
      }

      return {
        history,
        initialState: {
          ...createInitialSiteOperatorState(),
          pathHistory: [currentPath],
          sessionContext: ctx,
        },
        sessionConfig: {
          model: 'gpt-realtime-2.1',
          instructions: env.pageEditor
            ? `${env.pageEditor.instructions}\n\n${env.pageEditor.context ?? ''}`
            : buildVoiceInstructions(ctx),
          tools: env.pageEditor
            ? [
                ...env.pageEditor.tools,
                ...siteOperatorToolDefinitions
                  .filter((tool) => tool.name === 'delegate_task')
                  // Page-editor delegation always runs on the conversation's general helper,
                  // so the squad target must not be offered here.
                  .map((tool) => {
                    const { squadId: _squadId, ...properties } = tool.parameters.properties as Record<string, unknown>
                    return { ...tool, name: 'delegate', parameters: { ...tool.parameters, properties } }
                  }),
              ]
            : siteOperatorToolDefinitions,
          output_modalities: ['audio'],
          tool_choice: 'auto',
          reasoning: {
            effort: 'high',
          },
          truncation: {
            type: 'retention_ratio',
            retention_ratio: 0.8,
          },
          audio: {
            input: {
              transcription: {
                model: 'gpt-realtime-whisper',
              },
              turn_detection: {
                type: 'semantic_vad',
                eagerness: 'high',
                create_response: true,
                interrupt_response: true,
              },
            },
            output: {
              voice: 'cedar',
            },
          },
        },
      }
    },

    async executeTool({ name, toolArgs, env }) {
      if (env.pageEditor) {
        // The schema omits squadId, but the inherited description still mentions it: drop any the
        // model emits anyway, so page-editor delegation always lands on the general helper.
        if (name === 'delegate')
          return siteOperatorTools.execute('delegate_task', { ...toolArgs, squadId: undefined }, env)
        return env.pageEditor.execute(name, toolArgs)
      }
      return siteOperatorTools.execute(name, toolArgs, env)
    },

    summarizeToolCall(name, args) {
      return siteOperatorTools.summarizeCall(name === 'delegate' ? 'delegate_task' : name, args)
    },

    onOutputAudioStopped(runtime) {
      markActiveInboxAnnouncementRead(deps, runtime)
      runtime.flushPendingMessages()
    },

    onInterrupt(runtime) {
      clearActiveInboxAnnouncement(runtime)
    },

    useEffects: (runtime, env, status) => useSiteOperatorEffects(deps, runtime, env, status),
  }

  return {
    siteOperatorVoiceAssistant,
    __siteOperatorAssistantTest: {
      enqueueUnreadInboxAnnouncements: (
        runtime: VoiceAssistantRuntime<SiteOperatorAssistantState>,
        preferredMessageId?: string
      ) => enqueueUnreadInboxAnnouncements(deps, runtime, preferredMessageId),
      handleAgentWaitingInputEvent: deps.handleAgentWaitingInputEvent,
    },
  }
}

export const { siteOperatorVoiceAssistant, __siteOperatorAssistantTest } = createSiteOperatorAssistant({
  listSquads,
  listSquadAgents,
  getMyInbox,
  markAsRead,
  handleAgentWaitingInputEvent,
})
