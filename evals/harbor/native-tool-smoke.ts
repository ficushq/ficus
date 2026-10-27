/** Explicit two-call transport check. No benchmark score; uses the capped proxy. */
import { readFile } from 'node:fs/promises'
import { InMemoryCredentialStore, type Context } from '@earendil-works/pi-ai'
import { ModelRuntime } from '@earendil-works/pi-coding-agent'
import { Type } from '@sinclair/typebox'
import { configureHarborProvider } from '../../apps/core/src/scripts/harbor-provider'

const access = JSON.parse(await readFile(process.argv[2]!, 'utf8'))
if (access.model !== 'gpt-6.1-sol') throw new Error('Expected the Sol pilot proxy')
const credentials = new InMemoryCredentialStore()
await credentials.modify('openai', async () => ({ type: 'api_key', key: access.clients['native-tool-smoke'] }))
const runtime = await ModelRuntime.create({
  credentials,
  modelsPath: null,
  refreshOnCreate: false,
  allowModelNetwork: false,
})
configureHarborProvider(runtime, `http://127.0.0.1:${access.port}/v1`)
const model = runtime.getModel('openai', 'gpt-6.1-sol')!
const context: Context = {
  systemPrompt: 'Call read_marker once, then reply with exactly the marker returned by the tool.',
  messages: [{ role: 'user', content: 'Read the marker.', timestamp: Date.now() }],
  tools: [{ name: 'read_marker', description: 'Read a test marker.', parameters: Type.Object({}) }],
}
const first = await runtime.completeSimple(model, context, { reasoning: 'medium', maxTokens: 1024 })
const call = first.content.find((part) => part.type === 'toolCall')
if (!call || call.name !== 'read_marker')
  throw new Error(`Tool roundtrip failed: ${first.stopReason}; ${first.errorMessage ?? ''}`)
context.messages.push(first, {
  role: 'toolResult',
  toolCallId: call.id,
  toolName: call.name,
  content: [{ type: 'text', text: 'HARBOR_NATIVE_OK' }],
  isError: false,
  timestamp: Date.now(),
})
const second = await runtime.completeSimple(model, context, { reasoning: 'medium', maxTokens: 1024 })
const answer = second.content
  .filter((part) => part.type === 'text')
  .map((part) => part.text)
  .join('')
  .trim()
if (answer !== 'HARBOR_NATIVE_OK')
  throw new Error(`Tool result continuation failed: ${second.stopReason}; ${second.errorMessage ?? ''}`)
console.log(
  JSON.stringify({
    model: model.id,
    api: model.api,
    thinking: 'medium',
    toolCall: call.name,
    answer,
    requests: 2,
    stopReasons: [first.stopReason, second.stopReason],
  })
)
