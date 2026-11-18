import { createHash } from 'node:crypto'
import type { ModelRuntime } from '@earendil-works/pi-coding-agent'
import type {
  Api,
  AssistantMessage,
  Context,
  Model,
  StreamOptions,
  AssistantMessageEventStream,
  ToolCall,
} from '@earendil-works/pi-ai'
import { lazyStream } from '@earendil-works/pi-ai/api/lazy'
import { createLogger } from '../../lib/infra/logger'

type RuntimeStream = (model: Model<Api>, context: Context, options?: StreamOptions) => AssistantMessageEventStream
const RESPONSES_APIS = new Set(['openai-codex-responses', 'openai-responses', 'azure-openai-responses'])
const VALID_NAME = /^[a-zA-Z0-9_.-]+$/
const log = createLogger('responses-tool-names')
const MAX_DIAGNOSTIC_NAMES = 1024
const MAX_DIAGNOSTIC_NAME_LENGTH = 256
// Never evict: a replay must not re-enable warnings for previously seen names. Store only
// fixed-size full-name fingerprints, and suppress new diagnostics once the process cap is reached.
const warnedNames = new Set<string>()

function warnAliasedToolName(name: string, api: Api, fingerprint: string): void {
  if (warnedNames.size >= MAX_DIAGNOSTIC_NAMES || warnedNames.has(fingerprint)) return
  warnedNames.add(fingerprint)
  const preview =
    name.length > MAX_DIAGNOSTIC_NAME_LENGTH ? `${name.slice(0, MAX_DIAGNOSTIC_NAME_LENGTH)} [truncated]` : name
  // JSON escapes ASCII controls/quotes; escape all remaining non-printable or non-ASCII
  // code units too, including terminal controls, Unicode line separators and bidi controls.
  const diagnostic = JSON.stringify({ name: preview, api }).replace(
    /[^\x20-\x7e]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`
  )
  log.warn(`Aliased invalid Responses tool name: ${diagnostic}`)
}

/**
 * Adapt the entire request, not just Context.tools: Pi synthesizes tool_search_output and
 * additional_tools from historical system.toolsAdded. Keep stored names and dispatch names
 * untouched, and restore provider aliases on every stream event before Pi executes/persists them.
 */
export function responsesToolNameStream<T extends RuntimeStream>(stream: T): T {
  const wrapped: RuntimeStream = (model, context, options) => {
    if (!RESPONSES_APIS.has(model.api)) return stream(model, context, options)
    const names = new Set<string>()
    for (const tool of context.tools ?? []) names.add(tool.name)
    for (const message of context.messages) {
      if (message.role === 'system') {
        for (const tool of [...(message.toolsAdded ?? []), ...(message.toolsRemoved ?? [])]) names.add(tool.name)
      } else if (message.role === 'assistant') {
        for (const block of message.content) if (block.type === 'toolCall') names.add(block.name)
      } else if (message.role === 'toolResult') names.add(message.toolName)
    }
    const reserved = new Set([...names].filter((name) => VALID_NAME.test(name)))
    const aliases = new Map<string, string>()
    // Sorting makes collision resolution independent of declaration/call ordering. Reserve every
    // valid historical name first, including a name identical to another tool's generated alias.
    for (const name of [...names].sort()) {
      if (VALID_NAME.test(name)) continue
      const fingerprint = createHash('sha256').update(name, 'utf16le').digest('hex')
      const base = `ficus_tool_${fingerprint.slice(0, 40)}`
      let alias = base
      let suffix = 0
      while (reserved.has(alias)) alias = `${base}_${++suffix}`
      reserved.add(alias)
      aliases.set(name, alias)
      warnAliasedToolName(name, model.api, fingerprint)
    }
    if (!aliases.size) return stream(model, context, options)
    const encode = (name: string) => aliases.get(name) ?? name
    const originals = new Map([...aliases].map(([name, alias]) => [alias, name]))
    const decode = (call: ToolCall): ToolCall => ({ ...call, name: originals.get(call.name) ?? call.name })
    const restore = (message: AssistantMessage): AssistantMessage => ({
      ...message,
      content: message.content.map((block) => (block.type === 'toolCall' ? decode(block) : block)),
    })
    const request: Context = {
      ...context,
      ...(context.tools ? { tools: context.tools.map((tool) => ({ ...tool, name: encode(tool.name) })) } : {}),
      messages: context.messages.map((message) => {
        if (message.role === 'system')
          return {
            ...message,
            ...(message.toolsAdded
              ? { toolsAdded: message.toolsAdded.map((tool) => ({ ...tool, name: encode(tool.name) })) }
              : {}),
            ...(message.toolsRemoved
              ? { toolsRemoved: message.toolsRemoved.map((tool) => ({ ...tool, name: encode(tool.name) })) }
              : {}),
          }
        if (message.role === 'assistant')
          return {
            ...message,
            content: message.content.map((block) =>
              block.type === 'toolCall' ? { ...block, name: encode(block.name) } : block
            ),
          }
        if (message.role === 'toolResult') return { ...message, toolName: encode(message.toolName) }
        return message
      }),
    }
    return lazyStream(
      model,
      async () => {
        const source = stream(model, request, options)
        return {
          async *[Symbol.asyncIterator]() {
            for await (const event of source) {
              if (event.type === 'done') yield { ...event, message: restore(event.message) }
              else if (event.type === 'error') yield { ...event, error: restore(event.error) }
              else if (event.type === 'toolcall_end')
                yield { ...event, partial: restore(event.partial), toolCall: decode(event.toolCall) }
              else yield { ...event, partial: restore(event.partial) }
            }
          },
          result: async () => restore(await source.result()),
        }
      },
      undefined,
      options?.signal
    )
  }
  // The adapter changes neither the API-specific options nor the concrete return type.
  return wrapped as T
}

const protectedRuntimes = new WeakSet<ModelRuntime>()

/** Install once on both public streaming entry points; complete/completeSimple delegate to them. */
export function protectResponsesToolNames(runtime: ModelRuntime): void {
  if (protectedRuntimes.has(runtime)) return
  runtime.stream = responsesToolNameStream(runtime.stream.bind(runtime))
  runtime.streamSimple = responsesToolNameStream(runtime.streamSimple.bind(runtime))
  protectedRuntimes.add(runtime)
}
