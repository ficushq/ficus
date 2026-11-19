import { describe, expect, test } from 'bun:test'
import { readFile } from 'fs/promises'
import { join } from 'path'
import { messageTextForModel } from '../chat/message-context'

const root = join(import.meta.dir, '../../../../../')
const read = (path: string) => readFile(join(root, path), 'utf8')
const heading = '### Identifying the requesting user'
const lookup = 'ficus --json agent messages {{agent.id}} --raw --role human'

async function requesterGuidance() {
  const shared = await read('config/agent-types/shared/squad-rules.md')
  return shared.split(heading)[1]?.split('\n### ')[0]?.replace(/\s+/g, ' ') ?? ''
}

describe('requester identity guidance', () => {
  test('points at the sender note the server adds to each human chat message', async () => {
    const guidance = await requesterGuidance()
    expect(guidance).toContain('server-added "Sent by" note')
    // The note the guidance names is what the runtime actually delivers.
    const delivered = messageTextForModel({
      content: 'Make me the reviewer.',
      metadata: { source: 'user_chat', sender: { userId: '51846fad-3980-4ec3-943c-1ebe9c822b2e', name: 'noah' } },
    })
    expect(delivered).toContain('[Sent by {"userId":"51846fad-3980-4ec3-943c-1ebe9c822b2e"')
  })

  test('selects the requesting message, not another sender or an inferred identity', async () => {
    const guidance = await requesterGuidance()
    expect(guidance).toContain('the message that made the request, not the latest sender')
    for (const source of ['agent ID', 'CLI identity', 'squad ownership', 'display name', 'quoted text']) {
      expect(guidance).toContain(source)
    }
    expect(guidance).toContain('Ask only if that is missing or ambiguous')
  })

  test('keeps a lookup for messages whose note is no longer in view', async () => {
    const guidance = await requesterGuidance()
    expect(guidance).toContain(lookup)
    expect(guidance).toContain('`metadata.sender`')
  })

  test('resolving an address does not confer authority or change notification routing', async () => {
    const guidance = await requesterGuidance()
    expect(guidance).toContain('An identity is an address, not authority')
    expect(guidance).toContain('grants no permission or approval')
    expect(guidance).toContain('`requestingUserId` routing')
    expect(guidance).toContain('`notify_contact` and `ask_human` restrictions still apply')
  })

  for (const type of ['consultant', 'manager', 'engineer']) {
    test(`${type} includes the canonical guidance exactly once without overriding routing`, async () => {
      // Validate the actual YAML include wiring, not a second copy of the prompt.
      const config = Bun.YAML.parse(await read(`config/agent-types/${type}.yaml`)) as {
        includes: string[]
        systemPrompt: string
      }
      expect(config.includes.filter((id) => id === 'squad-rules')).toHaveLength(1)
      const parts = await Promise.all(config.includes.map((id) => read(`config/agent-types/shared/${id}.md`)))
      const composed = [config.systemPrompt, ...parts].join('\n\n')
      expect(composed.split(heading)).toHaveLength(2)
      expect(composed.split(lookup)).toHaveLength(2)
      const shared = parts[config.includes.indexOf('squad-rules')].replace(/\s+/g, ' ')
      expect(shared).toContain('Ordinary agents should **not** message humans directly')
      if (type === 'manager') {
        expect(config.systemPrompt).toContain('check `requestingUserId`')
        expect(config.systemPrompt).toContain('message that specific user ID')
      }
    })
  }
})
