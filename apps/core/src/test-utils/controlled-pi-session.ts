import { Agent as PiAgent } from '@earendil-works/pi-agent-core'
import { createAssistantMessageEventStream, type AssistantMessage, type Context } from '@earendil-works/pi-ai'
import {
  AgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from '@earendil-works/pi-coding-agent'

/** Real patched SDK with a manually advanced, network-free model boundary. */
export async function controlledPiSession(root: string, manager = SessionManager.create(root, root)) {
  const runtime = await ModelRuntime.create({
    credentials: {
      read: async () => ({ type: 'api_key' as const, key: 'fixture-only' }),
      list: async () => [],
      modify: async (_id, fn) => fn(undefined),
      delete: async () => {},
    },
    modelsPath: null,
    refreshOnCreate: false,
  })
  const model = runtime.getModel('anthropic', 'claude-sonnet-4-5')!
  const requests: Context[] = []
  const requestDeliveryIds: Array<Array<string | undefined>> = []
  const queueWaiters: Array<{ count: number; resolve: () => void }> = []
  const waiters: Array<{ count: number; resolve: () => void }> = []
  const streams: Array<ReturnType<typeof createAssistantMessageEventStream>> = []
  const assistant = (stopReason: AssistantMessage['stopReason'] = 'stop'): AssistantMessage => ({
    role: 'assistant',
    content: [{ type: 'text', text: 'fixture reply' }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    timestamp: Date.now(),
    stopReason,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  })
  const agent = new PiAgent({
    initialState: { model, messages: manager.buildSessionContext().messages },
    steeringMode: 'all',
    followUpMode: 'one-at-a-time',
    streamFn: (_model, context, options) => {
      // Correlate adapter inputs by object identity, not matching text or FIFO.
      // Normal SDK user messages are projected by reference; identities stay on
      // session entries and never enter the model-visible message itself.
      const entries = manager.getEntries()
      requestDeliveryIds.push(
        context.messages
          .filter((m) => m.role === 'user')
          .map((message) => {
            const entry = entries.find((e) => e.type === 'message' && e.message === message)
            return entry?.type === 'message' ? entry.deliveryId : undefined
          })
      )
      requests.push(structuredClone(context))
      const stream = createAssistantMessageEventStream()
      streams.push(stream)
      options?.signal?.addEventListener(
        'abort',
        () => stream.push({ type: 'error', reason: 'aborted', error: assistant('aborted') }),
        { once: true }
      )
      for (const waiter of waiters) if (requests.length >= waiter.count) waiter.resolve()
      return stream
    },
  })
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: false },
    steeringMode: 'all',
    followUpMode: 'one-at-a-time',
  })
  const loader = new DefaultResourceLoader({
    cwd: root,
    agentDir: root,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt: 'fixture',
  })
  await loader.reload()
  const session = new AgentSession({
    agent,
    sessionManager: manager,
    settingsManager,
    resourceLoader: loader,
    modelRuntime: runtime,
    cwd: root,
    baseToolsOverride: {},
    initialActiveToolNames: [],
  })
  session.subscribe((event) => {
    if (event.type === 'queue_update')
      for (const waiter of queueWaiters)
        if (event.steering.length + event.followUp.length >= waiter.count) waiter.resolve()
  })
  return {
    session,
    requests,
    requestDeliveryIds,
    async waitForQueue(count: number) {
      if (session.pendingMessageCount < count)
        await new Promise<void>((resolve) => queueWaiters.push({ count, resolve }))
    },
    async waitForRequest(count: number) {
      if (requests.length < count) await new Promise<void>((resolve) => waiters.push({ count, resolve }))
    },
    reply(index: number) {
      streams[index]!.push({ type: 'done', reason: 'stop', message: assistant() })
    },
  }
}
