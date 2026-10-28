/** Offline native session-manager probe. No provider or AgentSession is created. */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionManager } from '@earendil-works/pi-coding-agent'

const root = await mkdtemp(join(tmpdir(), 'ficus-pi-persistence-'))
try {
  const session = SessionManager.create(root, root)
  session.appendMessage({ role: 'user', content: 'Offline fixture: first increment', timestamp: 1 })
  session.appendMessage({
    role: 'assistant',
    content: [{ type: 'text', text: 'Offline fixture result; no model call.' }],
    api: 'openai-responses',
    provider: 'openai',
    model: 'no-provider-fixture',
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop',
    timestamp: 2,
  })
  const file = session.getSessionFile()!
  const before = await readFile(file, 'utf8')
  const resumed = SessionManager.continueRecent(root, root)
  if (resumed.getSessionId() !== session.getSessionId() || resumed.getSessionFile() !== file)
    throw new Error('Native continuation changed identity')
  resumed.appendMessage({ role: 'user', content: 'Offline fixture: second increment', timestamp: 3 })
  const after = await readFile(file, 'utf8')
  if (!after.startsWith(before)) throw new Error('Native continuation rewrote prior history')
  const context = resumed.buildSessionContext()
  if (context.messages.length !== 3) throw new Error('Native context lost earlier messages')
  console.log(
    JSON.stringify({
      native_version: '0.99.1',
      same_session_id: true,
      append_only_history: true,
      retained_context_messages: context.messages.length,
      provider_calls: 0,
    })
  )
} finally {
  await rm(root, { recursive: true, force: true })
}
