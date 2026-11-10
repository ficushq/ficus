import { useCallback, useEffect, useRef, useState } from 'react'
import { restoreVoiceConversation } from './voiceConversationRecovery'
import { createMicState } from './micState'
import { parseRealtimeRateLimitRetryDelay } from './realtimeErrors'
import { isRecoverableVoiceConnectionError } from './voiceConnectionErrors'
import { RealtimeTransport, type RealtimeServerEvent, type RealtimeSessionConfig } from './realtimeTransport'
import { useStableRef } from '../hooks/useStableRef'
import type {
  VoiceAssistantToolExecutionResult,
  VoiceRateLimitRetryStatus,
  VoiceStatus,
  VoiceTranscriptEntry,
} from './types'

export function appendUserTranscriptDeltaToHistory(
  history: VoiceTranscriptEntry[],
  delta: string
): VoiceTranscriptEntry[] {
  for (let i = history.length - 1; i >= 0; i--) {
    const entry = history[i]
    if (entry.role === 'user' && !entry.final) {
      const updated = [...history]
      updated[i] = { ...entry, text: entry.text + delta }
      return updated
    }
  }
  return [...history, { id: crypto.randomUUID(), role: 'user', text: delta, final: false, channel: 'voice' }]
}

export interface PreparedVoiceAssistantSession<TState> {
  history?: VoiceTranscriptEntry[]
  sessionConfig: RealtimeSessionConfig
  initialState?: TState
}

export interface PendingVoiceMessage<TState> {
  id: string
  text: string
  historyEntry?: VoiceTranscriptEntry
  dedupeKey?: string
  expiresAt?: number
  disableMic?: boolean
  onStart?: (runtime: VoiceAssistantRuntime<TState>) => void
  onDone?: (runtime: VoiceAssistantRuntime<TState>) => void
  onCancel?: (runtime: VoiceAssistantRuntime<TState>) => void
}

export interface VoiceAssistantRuntime<TState> {
  getState: () => TState
  setState: (state: TState | ((current: TState) => TState)) => void
  updateInstructions: (instructions: string) => void
  sendUserText: (text: string) => void
  requestResponse: () => void
  enqueueMessage: (message: PendingVoiceMessage<TState>) => void
  flushPendingMessages: () => void
  setMicEnabled: (enabled: boolean) => void
  isResponseActive: () => boolean
  markResponseActive: (active: boolean) => void
}

export interface VoiceAssistantController<TState, TEnv> {
  id: string
  initialState: TState | (() => TState)
  useEnvironment: () => TEnv
  prepareSession(args: { env: TEnv; signal: AbortSignal }): Promise<PreparedVoiceAssistantSession<TState>>
  executeTool(args: {
    name: string
    toolArgs: Record<string, unknown>
    env: TEnv
    runtime: VoiceAssistantRuntime<TState>
  }): Promise<VoiceAssistantToolExecutionResult>
  summarizeToolCall?(name: string, args: Record<string, unknown>): string
  onConnected?(runtime: VoiceAssistantRuntime<TState>, env: TEnv): void
  onDisconnected?(env: TEnv): void
  onServerEvent?(event: RealtimeServerEvent, runtime: VoiceAssistantRuntime<TState>, env: TEnv): void
  onOutputAudioStopped?(runtime: VoiceAssistantRuntime<TState>, env: TEnv): void
  onInterrupt?(runtime: VoiceAssistantRuntime<TState>, env: TEnv): void
  useEffects?(runtime: VoiceAssistantRuntime<TState>, env: TEnv, status: VoiceStatus): void
}

export type VoiceInputMode = 'automatic' | 'manual'

export function applyVoiceInputModeToSessionConfig(
  config: RealtimeSessionConfig,
  inputMode: VoiceInputMode
): RealtimeSessionConfig {
  if (inputMode === 'automatic') return config
  return {
    ...config,
    audio: {
      ...config.audio,
      input: {
        ...config.audio.input,
        turn_detection: null,
      },
    },
  }
}

export interface UseRealtimeVoiceAssistantOptions {
  textOnly?: boolean
  autoConnect?: boolean
  autoReconnect?: boolean
  reconnectDelayMs?: number
  reconnectClock?: Pick<typeof globalThis, 'setTimeout' | 'clearTimeout'> & { now?: () => number }
  maxReconnectAttempts?: number
  createTransport?: () => RealtimeTransport
  inputMode?: VoiceInputMode
}

export interface UseRealtimeVoiceAssistantReturn<TState> {
  enqueueMessage: (message: PendingVoiceMessage<TState>) => void
  sendText: (text: string, context?: string) => Promise<void>
  retryConnection: () => Promise<void>
  isReconnecting: boolean
  pendingTextCount: number
  setLiveAudio: (enabled: boolean) => Promise<void>
  isLiveAudio: boolean
  status: VoiceStatus
  history: VoiceTranscriptEntry[]
  error: string | null
  state: TState
  connect: () => Promise<void>
  disconnect: () => void
  restartFresh: () => Promise<void>
  updateInstructions: (instructions: string) => void
  interrupt: () => void
  toggle: () => void
  toggleMicMuted: () => void
  startUserSpeech: () => void
  submitUserSpeech: () => void
  isConnected: boolean
  isMicMuted: boolean
  inputLevel: number
  rateLimitRetry: VoiceRateLimitRetryStatus | null
}

function friendlyError(err: unknown): string {
  if (err instanceof DOMException) {
    if (err.name === 'NotAllowedError') return 'Microphone access denied'
    if (err.name === 'NotFoundError') return 'No microphone found'
    if (err.name === 'NotReadableError') return 'Microphone is in use by another app'
  }
  if (err instanceof Error) {
    if (err.message.includes('OpenAI API key')) return 'Voice not configured — missing API key'
    if (err.message.includes('Voice session failed')) return 'Failed to connect to voice service'
    return err.message
  }
  return 'Connection failed'
}

function resolveInitialState<TState>(initialState: TState | (() => TState)): TState {
  return typeof initialState === 'function' ? (initialState as () => TState)() : initialState
}

function summarizeArgs(args: Record<string, unknown>): string {
  return Object.entries(args)
    .map(([key, value]) => `${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`)
    .join(', ')
}

const BACKGROUND_VOICE_DISCONNECT_DELAY_MS = 10 * 60 * 1000
const STABLE_CONNECTION_RESET_MS = 30_000

function isActiveVoiceStatus(status: VoiceStatus): boolean {
  return status === 'listening' || status === 'user-speaking' || status === 'processing' || status === 'speaking'
}

function useNoopControllerEffects<TState, TEnv>(
  _runtime: VoiceAssistantRuntime<TState>,
  _env: TEnv,
  _status: VoiceStatus
): void {}

export function useRealtimeVoiceAssistant<TState, TEnv>(
  controller: VoiceAssistantController<TState, TEnv>,
  options: UseRealtimeVoiceAssistantOptions = {}
): UseRealtimeVoiceAssistantReturn<TState> {
  const env = controller.useEnvironment()
  const createTransportRef = useStableRef(options.createTransport)
  const inputMode = options.inputMode ?? 'automatic'

  const [status, setStatus] = useState<VoiceStatus>('idle')
  const [isLiveAudio, setIsLiveAudio] = useState(!options.textOnly)
  const liveAudioRef = useStableRef(isLiveAudio)
  const [history, setHistory] = useState<VoiceTranscriptEntry[]>([])
  const historyRef = useStableRef(history)
  const [error, setError] = useState<string | null>(null)
  const [rateLimitRetry, setRateLimitRetry] = useState<VoiceRateLimitRetryStatus | null>(null)
  const [isMicMuted, setIsMicMuted] = useState(false)
  const [inputLevel, setInputLevel] = useState(0)
  const [assistantState, setAssistantState] = useState<TState>(() => resolveInitialState(controller.initialState))

  // useEffects must be captured from the first render to preserve React hook order.
  // Remount this hook (for example with key={controller.id}) when switching controllers.
  const [initialController] = useState(() => ({
    id: controller.id,
    useEffects: controller.useEffects,
    useControllerEffects: controller.useEffects ?? useNoopControllerEffects<TState, TEnv>,
  }))
  const useControllerEffects = initialController.useControllerEffects
  const warnedControllerEffectsChangeRef = useRef(false)
  useEffect(() => {
    if (
      import.meta.env.DEV &&
      !warnedControllerEffectsChangeRef.current &&
      (initialController.id !== controller.id || initialController.useEffects !== controller.useEffects)
    ) {
      warnedControllerEffectsChangeRef.current = true
      console.warn(
        '[voice] useRealtimeVoiceAssistant captures controller.useEffects on first render to preserve hook order. Remount the hook when changing controllers.'
      )
    }
  }, [initialController, controller.id, controller.useEffects])
  const stateRef = useRef(assistantState)
  const setRuntimeState = useCallback((next: TState | ((current: TState) => TState)) => {
    const nextState = typeof next === 'function' ? (next as (value: TState) => TState)(stateRef.current) : next
    stateRef.current = nextState
    setAssistantState(nextState)
  }, [])

  const transportRef = useRef<RealtimeTransport | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const pendingConnect = useRef<Promise<void> | null>(null)
  const queuedText = useRef<(VoiceTranscriptEntry & { modelContext?: string })[]>([])
  const awaitingText = useRef<(VoiceTranscriptEntry & { modelContext?: string })[]>([])
  const resumeResponse = useRef(false)
  const [pendingTextCount, setPendingTextCount] = useState(0)
  // Do not invoke native browser timers as methods of our clock holder.
  const reconnectClock = useStableRef(
    options.reconnectClock ?? { setTimeout: setTimeout.bind(globalThis), clearTimeout: clearTimeout.bind(globalThis) }
  )
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const backgroundDisconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const backgroundPausedRef = useRef(false)
  const manualDisconnectRef = useRef(false)
  // The same flag for rendering: isReconnecting must not read the ref.
  const [manuallyDisconnected, setManuallyDisconnected] = useState(false)
  const [reconnectAttempt, setReconnectAttempt] = useState(0)
  const completedToolCallsRef = useRef<Map<string, VoiceAssistantToolExecutionResult>>(new Map())
  const toolEntriesRef = useRef<Map<string, VoiceTranscriptEntry>>(new Map())
  const pendingToolCallsRef = useRef<Map<string, Promise<VoiceAssistantToolExecutionResult>>>(new Map())
  // Per-turn output overrides leave the live session and its VAD audio defaults intact.
  const responseModalityRef = useRef<'text' | 'audio'>(options.textOnly ? 'text' : 'audio')
  const responseActiveRef = useRef(false)
  const pendingResponseCreateRef = useRef(false)
  const pendingMessagesRef = useRef<PendingVoiceMessage<TState>[]>([])
  const activeMessageRef = useRef<PendingVoiceMessage<TState> | null>(null)
  const rateLimitRetryTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const rateLimitRetryIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const interruptPendingRef = useRef(false)
  const suppressAssistantOutputRef = useRef(false)
  const outputAudioActiveRef = useRef(false)
  const outputAudioStoppedHandledRef = useRef(false)
  const latestInstructionsRef = useRef<string | null>(null)

  const controllerRef = useStableRef(controller)
  const envRef = useStableRef(env)
  const statusRef = useStableRef(status)
  // The mic state holds transportRef, so it is created on first use from a callback or effect,
  // never during render, and kept for the life of the hook.
  const micStateRef = useRef<ReturnType<typeof createMicState> | null>(null)
  const getMicState = useCallback(() => {
    if (micStateRef.current === null) micStateRef.current = createMicState(transportRef)
    return micStateRef.current
  }, [])
  const applyMicEnabled = useCallback(() => {
    getMicState().applyMicEnabled()
  }, [getMicState])

  const flushText = useCallback(() => {
    const transport = transportRef.current
    if (!transport?.isConnected || responseActiveRef.current || !queuedText.current.length) return
    awaitingText.current = queuedText.current.splice(0)
    responseModalityRef.current = 'text'
    for (const entry of awaitingText.current)
      transport.sendEvent({
        type: 'conversation.item.create',
        item: {
          id: entry.id,
          type: 'message',
          role: 'user',
          content: [
            { type: 'input_text', text: entry.modelContext ? `${entry.text}\n\n${entry.modelContext}` : entry.text },
          ],
        },
      })
    responseActiveRef.current = true
    setStatus('processing')
    transport.requestResponse('text')
  }, [])

  // The runtime the controller drives. Everything it uses is stable for the life of the hook, so it is
  // created once and can refer to itself (flushPendingMessages hands it to a starting message).
  const [runtime] = useState<VoiceAssistantRuntime<TState>>(() => {
    const runtime: VoiceAssistantRuntime<TState> = {
      getState: () => stateRef.current,
      setState: setRuntimeState,
      updateInstructions: (instructions) => {
        latestInstructionsRef.current = instructions
        transportRef.current?.updateSession({ instructions })
      },
      sendUserText: (text) => {
        transportRef.current?.sendEvent({
          type: 'conversation.item.create',
          item: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text }],
          },
        })
      },
      requestResponse: () => {
        const transport = transportRef.current
        if (!transport?.isConnected) return
        if (responseActiveRef.current) {
          pendingResponseCreateRef.current = true
          return
        }
        responseActiveRef.current = true
        setStatus('processing')
        transport.requestResponse(responseModalityRef.current)
      },
      enqueueMessage: (message) => {
        const key = message.dedupeKey ?? message.id
        const activeKey = activeMessageRef.current
          ? (activeMessageRef.current.dedupeKey ?? activeMessageRef.current.id)
          : null
        if (activeKey === key) return
        if (pendingMessagesRef.current.some((queued) => (queued.dedupeKey ?? queued.id) === key)) return
        pendingMessagesRef.current.push(message)
        runtime.flushPendingMessages()
      },
      flushPendingMessages: () => {
        const transport = transportRef.current
        if (!transport?.isConnected || responseActiveRef.current || statusRef.current === 'user-speaking') return
        const now = Date.now()
        pendingMessagesRef.current = pendingMessagesRef.current.filter(
          (message) => !message.expiresAt || message.expiresAt > now
        )
        const message = pendingMessagesRef.current.shift()
        if (!message) return
        activeMessageRef.current = message
        if (message.historyEntry)
          setHistory((history) =>
            history.some((entry) => entry.id === message.historyEntry!.id)
              ? history
              : [...history, message.historyEntry!]
          )
        message.onStart?.(runtime)
        if (message.disableMic !== false) getMicState().setMicEnabled(false)
        transport.sendEvent({
          type: 'conversation.item.create',
          item: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: message.text }],
          },
        })
        responseActiveRef.current = true
        setStatus('processing')
        transport.requestResponse(responseModalityRef.current)
      },
      setMicEnabled: (enabled) => {
        getMicState().setMicEnabled(enabled)
      },
      isResponseActive: () => responseActiveRef.current,
      markResponseActive: (active) => {
        responseActiveRef.current = active
      },
    }
    return runtime
  })
  const flushPendingMessages = runtime.flushPendingMessages

  useControllerEffects(runtime, env, status)

  const completeActiveMessage = useCallback(() => {
    const activeMessage = activeMessageRef.current
    if (!activeMessage) return
    activeMessageRef.current = null
    activeMessage.onDone?.(runtime)
  }, [runtime])

  const cancelActiveMessage = useCallback(() => {
    const activeMessage = activeMessageRef.current
    if (!activeMessage) return
    activeMessageRef.current = null
    activeMessage.onCancel?.(runtime)
  }, [runtime])

  const flushPendingResponseCreate = useCallback((transport: RealtimeTransport) => {
    if (!pendingResponseCreateRef.current || transportRef.current !== transport || !transport.isConnected) return
    pendingResponseCreateRef.current = false
    responseActiveRef.current = true
    transport.requestResponse(responseModalityRef.current)
  }, [])

  const appendAssistantDelta = useCallback((delta: string) => {
    setHistory((prev) => {
      const last = prev[prev.length - 1]
      if (last && last.role === 'assistant' && !last.final) {
        return [...prev.slice(0, -1), { ...last, text: last.text + delta }]
      }
      return [...prev, { id: crypto.randomUUID(), role: 'assistant', text: delta, final: false }]
    })
  }, [])

  const finalizeAssistantEntry = useCallback((text: string) => {
    setHistory((prev) => {
      const last = prev[prev.length - 1]
      if (last && last.role === 'assistant' && !last.final) {
        return [...prev.slice(0, -1), { ...last, text, final: true }]
      }
      return [...prev, { id: crypto.randomUUID(), role: 'assistant', text, final: true }]
    })
  }, [])

  const startNewAssistantEntry = useCallback(() => {
    setHistory((prev) => {
      const last = prev[prev.length - 1]
      if (last && last.role === 'assistant' && !last.final && last.text === '') return prev
      if (last && last.role === 'assistant' && !last.final) return [...prev.slice(0, -1), { ...last, final: true }]
      return prev
    })
  }, [])

  const addUserPlaceholder = useCallback(() => {
    setHistory((prev) => {
      const last = prev[prev.length - 1]
      if (last && last.role === 'user' && !last.final) return prev
      return [...prev, { id: crypto.randomUUID(), role: 'user', text: '', final: false, channel: 'voice' }]
    })
  }, [])

  const appendUserDelta = useCallback((delta: string) => {
    setHistory((prev) => appendUserTranscriptDeltaToHistory(prev, delta))
  }, [])

  const finalizeUserEntry = useCallback((text: string) => {
    setHistory((prev) => {
      for (let i = prev.length - 1; i >= 0; i--) {
        if (prev[i].role === 'user' && !prev[i].final) {
          const updated = [...prev]
          updated[i] = { ...updated[i], text, final: true }
          return updated
        }
      }
      return [...prev, { id: crypto.randomUUID(), role: 'user', text, final: true, channel: 'voice' }]
    })
  }, [])

  const markCurrentAssistantInterrupted = useCallback(() => {
    setHistory((prev) => {
      for (let i = prev.length - 1; i >= 0; i--) {
        if (prev[i].role === 'assistant' && !prev[i].final) {
          const updated = [...prev]
          updated[i] = { ...updated[i], final: true, interrupted: true }
          return updated
        }
      }
      return prev
    })
  }, [])

  const addToolCall = useCallback(
    (callId: string, name: string, args: Record<string, unknown>) => {
      const text = controllerRef.current.summarizeToolCall?.(name, args) ?? summarizeArgs(args)
      const entry: VoiceTranscriptEntry = {
        id: crypto.randomUUID(),
        role: 'tool',
        text,
        final: false,
        toolName: name,
        toolCallId: callId,
        toolArgs: JSON.stringify(args, null, 2),
      }
      toolEntriesRef.current.set(callId, entry)
      setHistory((prev) => [...prev, entry])
    },
    [controllerRef]
  )

  const finishToolCall = useCallback((callId: string, result: unknown, isError = false) => {
    const resultText = typeof result === 'string' ? result : JSON.stringify(result, null, 2)
    const entry = toolEntriesRef.current.get(callId)
    if (entry) toolEntriesRef.current.set(callId, { ...entry, final: true, toolResult: resultText, toolError: isError })
    setHistory((prev) => {
      const index = prev.findIndex((entry) => entry.role === 'tool' && entry.toolCallId === callId)
      if (index === -1) return prev
      const updated = [...prev]
      updated[index] = { ...updated[index], final: true, toolResult: resultText, toolError: isError }
      return updated
    })
  }, [])

  const clearReconnectTimer = useCallback(() => {
    if (reconnectTimeoutRef.current) {
      reconnectClock.current.clearTimeout(reconnectTimeoutRef.current)
      reconnectTimeoutRef.current = null
    }
  }, [reconnectClock])

  const clearRateLimitRetry = useCallback(() => {
    if (rateLimitRetryTimeoutRef.current) {
      clearTimeout(rateLimitRetryTimeoutRef.current)
      rateLimitRetryTimeoutRef.current = null
    }
    if (rateLimitRetryIntervalRef.current) {
      clearInterval(rateLimitRetryIntervalRef.current)
      rateLimitRetryIntervalRef.current = null
    }
    setRateLimitRetry(null)
  }, [])

  const scheduleRateLimitRetry = useCallback(
    (transport: RealtimeTransport, delayMs: number, reason: string) => {
      clearRateLimitRetry()
      const startedAt = Date.now()
      const updateRemaining = () => {
        setRateLimitRetry({ remainingMs: Math.max(delayMs - (Date.now() - startedAt), 0), reason })
      }

      responseActiveRef.current = true
      transport.setMicEnabled(false)
      setStatus('processing')
      setError(null)
      updateRemaining()

      rateLimitRetryIntervalRef.current = setInterval(updateRemaining, 100)
      rateLimitRetryTimeoutRef.current = setTimeout(() => {
        clearRateLimitRetry()
        if (transportRef.current !== transport || !transport.isConnected) return
        transport.requestResponse(responseModalityRef.current)
      }, delayMs)
    },
    [clearRateLimitRetry]
  )

  const shouldRequestFollowUp = useCallback((results: VoiceAssistantToolExecutionResult[]) => {
    return results.every((result) => result.followUp !== 'never' && result.followUp !== false)
  }, [])

  const executeToolCall = useCallback(
    (callId: string, name: string, argsString: string): Promise<VoiceAssistantToolExecutionResult> => {
      const existing = pendingToolCallsRef.current.get(callId)
      if (existing) return existing

      const completed = completedToolCallsRef.current.get(callId)
      if (completed) return Promise.resolve(completed)

      const promise: Promise<VoiceAssistantToolExecutionResult> = (async () => {
        const transport = transportRef.current
        const isCurrentTransport = (candidate: RealtimeTransport | null): candidate is RealtimeTransport =>
          candidate !== null && transportRef.current === candidate && candidate.isConnected
        try {
          const args = JSON.parse(argsString) as Record<string, unknown>
          addToolCall(callId, name, args)
          const result = await controllerRef.current.executeTool({
            name,
            toolArgs: args,
            env: envRef.current,
            runtime: runtime,
          })
          const toolResult = result.result
          const failed =
            toolResult !== null &&
            typeof toolResult === 'object' &&
            (('error' in toolResult && Boolean(toolResult.error)) ||
              ('isError' in toolResult && toolResult.isError === true))
          finishToolCall(callId, toolResult, failed)
          if (toolEntriesRef.current.has(callId)) completedToolCallsRef.current.set(callId, result)
          if (isCurrentTransport(transport)) transport.sendFunctionResult(callId, result.result)
          return result
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Tool execution failed'
          const result: VoiceAssistantToolExecutionResult = { result: { error: message }, followUp: 'auto' }
          finishToolCall(callId, result.result, true)
          if (toolEntriesRef.current.has(callId)) completedToolCallsRef.current.set(callId, result)
          if (isCurrentTransport(transport)) transport.sendFunctionResult(callId, result.result)
          return result
        }
      })()

      void promise.finally(() => {
        if (pendingToolCallsRef.current.get(callId) === promise) {
          pendingToolCallsRef.current.delete(callId)
        }
      })
      pendingToolCallsRef.current.set(callId, promise)
      return promise
    },
    [addToolCall, controllerRef, envRef, finishToolCall, runtime]
  )

  const handleServerEvent = useCallback(
    (event: RealtimeServerEvent, transport: RealtimeTransport) => {
      // Keep lifecycle diagnostics readable in browser log exports without
      // logging transcripts, tool arguments, SDP, or local network addresses.
      if (event.type === 'session.created' || event.type === 'session.updated') {
        const session = event.session as { id?: string; model?: string } | undefined
        console.info('[voice] session:', JSON.stringify({ event: event.type, id: session?.id, model: session?.model }))
      } else if (event.type === 'response.created' || event.type === 'response.done') {
        const response = event.response as
          | {
              id?: string
              status?: string
              status_details?: { type?: string; reason?: string; error?: { code?: string } }
            }
          | undefined
        console.info(
          '[voice] response:',
          JSON.stringify({
            event: event.type,
            id: response?.id,
            status: response?.status,
            reason: response?.status_details?.reason,
            code: response?.status_details?.error?.code,
          })
        )
      } else if (event.type.startsWith('output_audio_buffer.')) {
        console.info('[voice] playback:', JSON.stringify({ event: event.type, responseId: event.response_id }))
      }
      switch (event.type) {
        case 'input_audio_buffer.speech_started':
          responseModalityRef.current = 'audio'
          addUserPlaceholder()
          setStatus('user-speaking')
          break

        case 'input_audio_buffer.speech_stopped':
          setStatus('processing')
          break

        case 'output_audio_buffer.started':
          outputAudioActiveRef.current = true
          transport.resumeOutputPlayback()
          getMicState().setMicEnabled(false)
          setStatus('speaking')
          break

        case 'output_audio_buffer.stopped': {
          outputAudioActiveRef.current = false
          const shouldNotifyStopped = !outputAudioStoppedHandledRef.current
          outputAudioStoppedHandledRef.current = true
          getMicState().markResponseInactive(runtime)
          setStatus('listening')
          if (shouldNotifyStopped) controllerRef.current.onOutputAudioStopped?.(runtime, envRef.current)
          completeActiveMessage()
          flushPendingMessages()
          flushPendingResponseCreate(transport)
          break
        }

        case 'response.created':
          awaitingText.current = []
          setPendingTextCount(queuedText.current.length)
          outputAudioActiveRef.current = false
          outputAudioStoppedHandledRef.current = false
          interruptPendingRef.current = false
          suppressAssistantOutputRef.current = false
          responseActiveRef.current = true
          pendingResponseCreateRef.current = false
          startNewAssistantEntry()
          setStatus((prev) => (prev === 'speaking' ? prev : 'processing'))
          break

        case 'response.done': {
          const response = (
            event as {
              response?: {
                status?: string
                status_details?: { type?: string; reason?: string; error?: { message?: string; code?: string } }
                output?: Array<{ type?: string; call_id?: string; name?: string; arguments?: string }>
              }
            }
          ).response
          if (response?.status && response.status !== 'completed') {
            const details = response.status_details
            const wasCancelled =
              response.status === 'cancelled' || details?.type === 'cancelled' || details?.reason === 'client_cancelled'
            if (wasCancelled) {
              interruptPendingRef.current = false
              suppressAssistantOutputRef.current = false
              cancelActiveMessage()
            } else {
              const retry = parseRealtimeRateLimitRetryDelay(details?.error)
              console.error('[voice] response did not complete:', response)
              if (retry) {
                scheduleRateLimitRetry(transport, retry.delayMs, retry.reason)
                break
              }

              const message =
                details?.error?.message ??
                details?.reason ??
                details?.type ??
                `Realtime response ended with status: ${response.status}`
              if (message.toLowerCase().includes('already has an active response')) {
                responseActiveRef.current = true
                pendingResponseCreateRef.current = true
                break
              }
              setError(message)
              if (isRecoverableVoiceConnectionError(message)) {
                resumeResponse.current = true
                setStatus('error')
                break
              }
            }
          }

          // A completed turn proves this connection recovered. The retry budget
          // applies to one outage, not the lifetime of a conversation.
          if (response?.status === 'completed') setReconnectAttempt(0)
          resumeResponse.current = false
          const output = response?.output ?? []
          const functionCalls = output.filter((item) => item.type === 'function_call' && item.call_id && item.name)
          if (functionCalls.length > 0) {
            const allPromises = functionCalls.map((item) =>
              executeToolCall(item.call_id!, item.name!, item.arguments ?? '{}')
            )
            void Promise.all(allPromises).then((results) => {
              if (transportRef.current !== transport || !transport.isConnected) return
              if (shouldRequestFollowUp(results)) {
                // The tool-calling response is complete at response.done. Release the active-response
                // guard before creating the follow-up response with function results; otherwise
                // requestResponse() queues behind a response that has no more audio/stopped events.
                responseActiveRef.current = false
                runtime.requestResponse()
              } else {
                getMicState().markResponseInactive(runtime)
                setStatus('listening')
                completeActiveMessage()
                flushPendingMessages()
                flushText()
              }
            })
          } else if (outputAudioActiveRef.current) {
            setStatus((prev) => (prev === 'speaking' ? prev : 'speaking'))
          } else {
            getMicState().markResponseInactive(runtime)
            setStatus('listening')
            if (!outputAudioStoppedHandledRef.current) {
              outputAudioStoppedHandledRef.current = true
              controllerRef.current.onOutputAudioStopped?.(runtime, envRef.current)
            }
            completeActiveMessage()
            flushPendingMessages()
            flushPendingResponseCreate(transport)
            flushText()
          }
          break
        }

        case 'response.output_audio_transcript.delta': {
          if (suppressAssistantOutputRef.current) break
          const delta = (event as { delta?: string }).delta
          if (delta) appendAssistantDelta(delta)
          break
        }

        case 'response.output_audio_transcript.done': {
          if (suppressAssistantOutputRef.current) break
          const transcript = (event as { transcript?: string }).transcript
          if (transcript) finalizeAssistantEntry(transcript)
          break
        }

        case 'response.output_text.delta': {
          if (suppressAssistantOutputRef.current) break
          const delta = (event as { delta?: string }).delta
          if (delta) appendAssistantDelta(delta)
          break
        }

        case 'response.output_text.done': {
          if (suppressAssistantOutputRef.current) break
          const text = (event as { text?: string }).text
          if (text) finalizeAssistantEntry(text)
          break
        }

        case 'conversation.item.input_audio_transcription.delta': {
          const delta = (event as { delta?: string }).delta
          if (delta) appendUserDelta(delta)
          break
        }

        case 'conversation.item.input_audio_transcription.completed': {
          const transcript = (event as { transcript?: string }).transcript
          if (transcript?.trim()) finalizeUserEntry(transcript.trim())
          break
        }

        case 'response.output_item.done': {
          const item = (event as { item?: { type?: string; call_id?: string; name?: string; arguments?: string } }).item
          if (item?.type === 'function_call' && item.call_id && item.name) {
            void executeToolCall(item.call_id, item.name, item.arguments ?? '{}')
          }
          break
        }

        case 'rate_limits.updated': {
          const limits = (event as { rate_limits?: Array<{ name?: string; remaining?: number; limit?: number }> })
            .rate_limits
          if (limits) {
            console.debug('[voice] rate limits:', limits.map((l) => `${l.name}: ${l.remaining}/${l.limit}`).join(', '))
          }
          break
        }

        case 'error': {
          const errorEvent = event as { error?: { message?: string; code?: string; type?: string; event_id?: string } }
          const errMsg = errorEvent.error?.message ?? 'Realtime API error'
          if (interruptPendingRef.current && errMsg.toLowerCase().includes('no active response')) {
            interruptPendingRef.current = false
            suppressAssistantOutputRef.current = false
            break
          }
          console.error('[voice] realtime error:', errMsg, errorEvent.error?.code ?? '')
          if (errMsg.toLowerCase().includes('already has an active response')) {
            responseActiveRef.current = true
            pendingResponseCreateRef.current = true
            break
          }
          if (isRecoverableVoiceConnectionError(errMsg)) resumeResponse.current ||= responseActiveRef.current
          getMicState().markResponseInactive(runtime)
          setError(errMsg)
          setStatus('error')
          break
        }

        default:
          console.log('unknown event:', event.type)
          break
      }

      controllerRef.current.onServerEvent?.(event, runtime, envRef.current)
    },
    [
      addUserPlaceholder,
      appendAssistantDelta,
      appendUserDelta,
      controllerRef,
      envRef,
      executeToolCall,
      finalizeAssistantEntry,
      completeActiveMessage,
      cancelActiveMessage,
      finalizeUserEntry,
      flushPendingMessages,
      flushText,
      flushPendingResponseCreate,
      runtime,
      getMicState,
      scheduleRateLimitRetry,
      shouldRequestFollowUp,
      startNewAssistantEntry,
    ]
  )

  const handleServerEventRef = useStableRef(handleServerEvent)

  const resetRuntimeState = useCallback((preserveTools = false) => {
    if (!preserveTools) {
      toolEntriesRef.current.clear()
      completedToolCallsRef.current.clear()
      pendingToolCallsRef.current.clear()
    }
    pendingMessagesRef.current = []
    activeMessageRef.current = null
    responseActiveRef.current = false
    pendingResponseCreateRef.current = false
    interruptPendingRef.current = false
    suppressAssistantOutputRef.current = false
    outputAudioActiveRef.current = false
    outputAudioStoppedHandledRef.current = false
  }, [])

  const clearBackgroundDisconnectTimer = useCallback(() => {
    if (backgroundDisconnectTimeoutRef.current) clearTimeout(backgroundDisconnectTimeoutRef.current)
    backgroundDisconnectTimeoutRef.current = null
  }, [])

  const performConnect = useCallback(
    async (args: { preserveSession: boolean; liveAudio?: boolean }) => {
      manualDisconnectRef.current = false
      setManuallyDisconnected(false)
      backgroundPausedRef.current = false
      clearBackgroundDisconnectTimer()
      clearReconnectTimer()
      const preserveSession = args.preserveSession
      resumeResponse.current = preserveSession && (resumeResponse.current || responseActiveRef.current)
      queuedText.current = [...awaitingText.current, ...queuedText.current]
      awaitingText.current = []
      const connectingLiveAudio = args.liveAudio ?? liveAudioRef.current
      const preservedState = stateRef.current
      const preservedUserMicEnabled = getMicState().getUserMicEnabled()

      abortRef.current?.abort()
      transportRef.current?.disconnect()
      transportRef.current = null

      const abort = new AbortController()
      abortRef.current = abort

      if (!preserveSession || args.liveAudio === true) {
        setReconnectAttempt(0)
        const initialUserMicEnabled = connectingLiveAudio && inputMode === 'automatic'
        getMicState().setUserMicEnabled(initialUserMicEnabled)
        setIsMicMuted(!initialUserMicEnabled)
      } else {
        getMicState().setUserMicEnabled(preservedUserMicEnabled)
        setIsMicMuted(!preservedUserMicEnabled)
      }
      setStatus('connecting')
      setError(null)
      setInputLevel(0)
      if (!preserveSession) setHistory([])
      clearRateLimitRetry()
      resetRuntimeState(preserveSession)
      if (preserveSession) {
        setRuntimeState(preservedState)
      } else {
        setRuntimeState(resolveInitialState(controllerRef.current.initialState))
      }

      const isCurrentConnection = () => abortRef.current === abort && !abort.signal.aborted

      try {
        // Let in-flight tools finish before restoring their results. Never rerun a
        // side effect just because the transport that requested it disappeared.
        if (preserveSession) await Promise.allSettled([...pendingToolCallsRef.current.values()])
        if (!isCurrentConnection()) return
        const prepared = await controllerRef.current.prepareSession({ env: envRef.current, signal: abort.signal })
        if (!isCurrentConnection()) return
        if (prepared.initialState !== undefined && !preserveSession) setRuntimeState(prepared.initialState)

        const transport = createTransportRef.current?.() ?? new RealtimeTransport()
        if (!isCurrentConnection()) return
        transportRef.current = transport

        const preparedConfig = latestInstructionsRef.current
          ? { ...prepared.sessionConfig, instructions: latestInstructionsRef.current }
          : prepared.sessionConfig
        const sessionConfig = applyVoiceInputModeToSessionConfig(
          {
            ...preparedConfig,
            ...(options.textOnly ? { output_modalities: connectingLiveAudio ? ['audio'] : ['text'] } : {}),
          },
          inputMode
        )

        let connectedAt: number | null = null
        await transport.connect(
          sessionConfig,
          {
            onServerEvent: (event) => {
              if (transportRef.current !== transport || !transport.isConnected) return
              handleServerEventRef.current(event, transport)
            },
            onError: (err) => {
              if (transportRef.current !== transport) return
              const now = reconnectClock.current.now?.() ?? Date.now()
              if (connectedAt !== null && now - connectedAt >= STABLE_CONNECTION_RESET_MS) setReconnectAttempt(0)
              setError(err.message)
              setStatus('error')
            },
            onInputLevel: setInputLevel,
          },
          abort.signal,
          { initialMicEnabled: getMicState().getUserMicEnabled(), textOnly: !connectingLiveAudio }
        )

        if (!isCurrentConnection() || transportRef.current !== transport) {
          transport.disconnect()
          return
        }

        connectedAt = reconnectClock.current.now?.() ?? Date.now()

        // Tool completion can resolve before React commits its transcript update.
        // Use the execution records when restoring a connection in that same tick.
        const local = preserveSession
          ? [
              ...new Map([
                ...historyRef.current.map((entry) => [entry.id, entry] as const),
                ...[...toolEntriesRef.current.values()].map((entry) => [entry.id, entry] as const),
              ]).values(),
            ]
          : []
        const byId = new Map([...local, ...queuedText.current].map((entry) => [entry.id, entry]))
        const recovered = [
          ...(prepared.history ?? []).map((entry) => byId.get(entry.id) ?? entry),
          ...[...local, ...queuedText.current].filter(
            (entry, index, entries) =>
              !prepared.history?.some((prior) => prior.id === entry.id) &&
              entries.findIndex((other) => other.id === entry.id) === index
          ),
        ]
        setHistory(recovered)
        const unsentIds = new Set(queuedText.current.map((entry) => entry.id))
        // Queued model input (including task updates awaiting catch-up) is sent by the queue itself;
        // restoring its history entry as context too would inject the same content twice.
        const queuedEntryIds = new Set(
          [...pendingMessagesRef.current, ...(activeMessageRef.current ? [activeMessageRef.current] : [])]
            .map((message) => message.historyEntry?.id)
            .filter((id): id is string => Boolean(id))
        )
        restoreVoiceConversation(
          transport,
          recovered.filter((entry) => !unsentIds.has(entry.id)),
          queuedEntryIds
        )
        applyMicEnabled()
        setIsMicMuted(!getMicState().getUserMicEnabled())
        setStatus('listening')
        controllerRef.current.onConnected?.(runtime, envRef.current)
        flushText()
        if (resumeResponse.current && !responseActiveRef.current) runtime.requestResponse()
        resumeResponse.current = false
      } catch (err) {
        if (!isCurrentConnection() || (err instanceof DOMException && err.name === 'AbortError')) return
        transportRef.current?.disconnect()
        transportRef.current = null
        setError(friendlyError(err))
        setStatus('error')
      }
    },
    [
      applyMicEnabled,
      clearBackgroundDisconnectTimer,
      clearRateLimitRetry,
      clearReconnectTimer,
      controllerRef,
      createTransportRef,
      envRef,
      handleServerEventRef,
      flushText,
      historyRef,
      inputMode,
      liveAudioRef,
      options.textOnly,
      reconnectClock,
      getMicState,
      resetRuntimeState,
      runtime,
      setRuntimeState,
    ]
  )

  const connectInternal = useCallback(
    (args: { preserveSession: boolean; liveAudio?: boolean }) => {
      if (pendingConnect.current) return pendingConnect.current
      const operation = performConnect(args).finally(() => {
        if (pendingConnect.current === operation) pendingConnect.current = null
      })
      pendingConnect.current = operation
      return operation
    },
    [performConnect]
  )

  const connect = useCallback(async () => {
    await connectInternal({ preserveSession: false })
  }, [connectInternal])

  const reconnectSameSession = useCallback(async () => {
    await connectInternal({ preserveSession: true })
  }, [connectInternal])

  const disconnect = useCallback(() => {
    manualDisconnectRef.current = true
    setManuallyDisconnected(true)
    backgroundPausedRef.current = false
    getMicState().setUserMicEnabled(true)
    setIsMicMuted(false)
    clearReconnectTimer()
    clearBackgroundDisconnectTimer()
    abortRef.current?.abort()
    abortRef.current = null
    pendingConnect.current = null
    transportRef.current?.disconnect()
    transportRef.current = null
    resetRuntimeState()
    clearRateLimitRetry()
    setStatus('idle')
    if (!options.textOnly) setHistory([])
    setIsLiveAudio(false)
    setError(null)
    setInputLevel(0)
    setRuntimeState(resolveInitialState(controllerRef.current.initialState))
    controllerRef.current.onDisconnected?.(envRef.current)
  }, [
    clearBackgroundDisconnectTimer,
    clearRateLimitRetry,
    clearReconnectTimer,
    controllerRef,
    envRef,
    getMicState,
    options.textOnly,
    resetRuntimeState,
    setRuntimeState,
  ])

  const interrupt = useCallback(() => {
    clearRateLimitRetry()
    resumeResponse.current = false
    if (interruptPendingRef.current) return
    responseActiveRef.current = false
    outputAudioActiveRef.current = false
    outputAudioStoppedHandledRef.current = true
    cancelActiveMessage()
    controllerRef.current.onInterrupt?.(runtime, envRef.current)
    const transport = transportRef.current
    if (!transport?.isConnected) return

    interruptPendingRef.current = true
    suppressAssistantOutputRef.current = true
    markCurrentAssistantInterrupted()
    transport.stopOutputPlayback()
    transport.cancelResponse()
    applyMicEnabled()
    setStatus('listening')
  }, [
    applyMicEnabled,
    cancelActiveMessage,
    clearRateLimitRetry,
    controllerRef,
    envRef,
    markCurrentAssistantInterrupted,
    runtime,
  ])

  const restartFresh = useCallback(async () => {
    queuedText.current = []
    awaitingText.current = []
    resumeResponse.current = false
    setPendingTextCount(0)
    pendingConnect.current = null
    manualDisconnectRef.current = false
    setManuallyDisconnected(false)
    clearReconnectTimer()
    abortRef.current?.abort()
    transportRef.current?.disconnect()
    transportRef.current = null
    resetRuntimeState()
    clearRateLimitRetry()
    setHistory([])
    setError(null)
    setInputLevel(0)
    setRuntimeState(resolveInitialState(controllerRef.current.initialState))
    await connect()
  }, [clearRateLimitRetry, clearReconnectTimer, connect, controllerRef, resetRuntimeState, setRuntimeState])

  const pauseForBackground = useCallback(() => {
    if (backgroundPausedRef.current || manualDisconnectRef.current) return
    if (!transportRef.current) return
    console.info('[voice] page hidden for 10 minutes; pausing realtime session')
    backgroundPausedRef.current = true
    clearReconnectTimer()
    clearRateLimitRetry()
    abortRef.current?.abort()
    abortRef.current = null
    transportRef.current.disconnect()
    transportRef.current = null
    resetRuntimeState()
    setStatus('idle')
    setError(null)
    setInputLevel(0)
  }, [clearRateLimitRetry, clearReconnectTimer, resetRuntimeState])

  const toggleMicMuted = useCallback(() => {
    setIsMicMuted(getMicState().toggleMicMuted())
  }, [getMicState])

  const startUserSpeech = useCallback(() => {
    const transport = transportRef.current
    if (!transport?.isConnected || responseActiveRef.current) return
    clearRateLimitRetry()
    transport.clearInputAudioBuffer()
    getMicState().setUserMicEnabled(true)
    setIsMicMuted(false)
    addUserPlaceholder()
    setStatus('user-speaking')
  }, [addUserPlaceholder, clearRateLimitRetry, getMicState])

  const submitUserSpeech = useCallback(() => {
    const transport = transportRef.current
    if (!transport?.isConnected) return
    responseActiveRef.current = true
    if (inputMode === 'manual') {
      getMicState().setUserMicEnabled(false)
      setIsMicMuted(true)
    } else {
      getMicState().setMicEnabled(false)
    }
    transport.submitInputAudioBuffer()
    setStatus('processing')
  }, [inputMode, getMicState])

  const toggle = useCallback(() => {
    if (status === 'idle' || status === 'error') {
      void connect()
    } else {
      disconnect()
    }
  }, [connect, disconnect, status])

  useEffect(() => {
    if (!options.autoConnect) return
    void connect()
  }, [connect, options.autoConnect])

  useEffect(() => {
    if (typeof document === 'undefined') return

    const clearHiddenTimer = () => {
      clearBackgroundDisconnectTimer()
    }
    const scheduleHiddenTimer = () => {
      if (!document.hidden || backgroundPausedRef.current || !isActiveVoiceStatus(statusRef.current)) return
      if (backgroundDisconnectTimeoutRef.current) return
      backgroundDisconnectTimeoutRef.current = setTimeout(() => {
        backgroundDisconnectTimeoutRef.current = null
        if (document.hidden && isActiveVoiceStatus(statusRef.current)) pauseForBackground()
      }, BACKGROUND_VOICE_DISCONNECT_DELAY_MS)
    }
    const handleVisibilityChange = () => {
      if (document.hidden) {
        scheduleHiddenTimer()
        return
      }
      clearHiddenTimer()
      if (backgroundPausedRef.current) {
        backgroundPausedRef.current = false
        void reconnectSameSession()
      }
    }

    handleVisibilityChange()
    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      clearHiddenTimer()
    }
  }, [clearBackgroundDisconnectTimer, pauseForBackground, reconnectSameSession, status, statusRef])

  useEffect(() => {
    if (!options.autoReconnect || status !== 'error') return
    if (manualDisconnectRef.current || !isRecoverableVoiceConnectionError(error)) return

    if (reconnectAttempt >= (options.maxReconnectAttempts ?? Infinity)) return
    clearReconnectTimer()
    const delayMs = Math.min(Math.max(options.reconnectDelayMs ?? 1000, 0) * 2 ** reconnectAttempt, 10_000)
    reconnectTimeoutRef.current = reconnectClock.current.setTimeout(() => {
      reconnectTimeoutRef.current = null
      if (manualDisconnectRef.current) return
      setReconnectAttempt((attempt) => attempt + 1)
      void reconnectSameSession()
    }, delayMs)

    return clearReconnectTimer
  }, [
    clearReconnectTimer,
    error,
    options.autoReconnect,
    reconnectClock,
    options.reconnectDelayMs,
    options.maxReconnectAttempts,
    reconnectAttempt,
    reconnectSameSession,
    status,
  ])

  useEffect(() => {
    return () => {
      abortRef.current?.abort()
      clearBackgroundDisconnectTimer()
      clearReconnectTimer()
      clearRateLimitRetry()
      transportRef.current?.disconnect()
    }
  }, [clearBackgroundDisconnectTimer, clearRateLimitRetry, clearReconnectTimer])

  const ensureConnected = useCallback(
    async (liveAudio?: boolean) => {
      if (transportRef.current?.isConnected && statusRef.current !== 'error') return
      await connectInternal({ preserveSession: true, liveAudio })
    },
    [connectInternal, statusRef]
  )

  const retryConnection = useCallback(async () => {
    setReconnectAttempt(0)
    await connectInternal({ preserveSession: true })
  }, [connectInternal])

  const sendText = useCallback(
    async (text: string, context?: string) => {
      if (!text.trim()) return
      const entry: VoiceTranscriptEntry = {
        id: crypto.randomUUID().replaceAll('-', ''),
        role: 'user',
        text,
        final: true,
        channel: 'text',
      }
      queuedText.current.push({ ...entry, modelContext: context })
      setPendingTextCount(queuedText.current.length + awaitingText.current.length)
      setHistory((previous) => [...previous, entry])
      setReconnectAttempt(0)
      await ensureConnected()
      // Failed setup leaves the entry queued and visible. Reconnect drains it;
      // the UI never has to manufacture a second submission.
      flushText()
    },
    [ensureConnected, flushText]
  )

  const setLiveAudio = useCallback(
    async (enabled: boolean) => {
      await ensureConnected(enabled)
      const transport = transportRef.current
      if (!transport?.isConnected) throw new Error('Realtime could not connect')
      if (enabled) await transport.enableAudioInput(true)
      else {
        interrupt()
        await transport.disableAudioInput()
      }
      if (transportRef.current !== transport || !transport.isConnected) throw new Error('Realtime connection changed')
      getMicState().setUserMicEnabled(enabled)
      setIsMicMuted(!enabled)
      setIsLiveAudio(enabled)
      transport.updateSession({ output_modalities: enabled ? ['audio'] : ['text'] })
    },
    [ensureConnected, getMicState, interrupt]
  )

  return {
    enqueueMessage: runtime.enqueueMessage,
    sendText,
    retryConnection,
    pendingTextCount,
    isReconnecting: Boolean(
      options.autoReconnect &&
      !manuallyDisconnected &&
      status === 'error' &&
      isRecoverableVoiceConnectionError(error) &&
      reconnectAttempt < (options.maxReconnectAttempts ?? Infinity)
    ),
    setLiveAudio,
    isLiveAudio,
    status,
    history,
    error,
    state: assistantState,
    connect,
    disconnect,
    restartFresh,
    updateInstructions: runtime.updateInstructions,
    interrupt,
    toggle,
    toggleMicMuted,
    startUserSpeech,
    isConnected:
      status === 'listening' || status === 'user-speaking' || status === 'processing' || status === 'speaking',
    isMicMuted,
    inputLevel,
    submitUserSpeech,
    rateLimitRetry,
  }
}
