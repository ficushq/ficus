import { describe, expect, test } from 'bun:test'
import { readFile } from 'fs/promises'
import { join } from 'path'

const root = join(import.meta.dir, '../../../../../')
const read = (path: string) => readFile(join(root, path), 'utf8')
const heading = '### Identifying the requesting user'
const recipe = 'ficus --json agent messages {{agent.id}} --raw --role human --last 2'

async function requesterGuidance() {
  const shared = await read('config/agent-types/shared/squad-rules.md')
  return shared.split(heading)[1]?.split('\n### ')[0]?.replace(/\s+/g, ' ') ?? ''
}

describe('requester identity guidance', () => {
  test('teaches the raw plus global JSON recipe and stable addressing fields', async () => {
    const guidance = await requesterGuidance()
    expect(guidance).toContain(recipe)
    expect(guidance).toContain('.messages[].metadata.sender.userId')
    expect(guidance).toContain('.messages[].metadata.sender.name')
    expect(guidance).toContain('stable `userId` for addressing')
    expect(guidance).toContain('`name` only for display')
  })

  test('selects the relevant request rather than another recent sender', async () => {
    const guidance = await requesterGuidance()
    expect(guidance).toContain('Match the requesting message by content, ID, and timestamp')
    expect(guidance).toContain('not blindly use the latest sender')
    expect(guidance).toContain('--last')
    expect(guidance).toContain('--search')
    expect(guidance).toContain('absent, inaccessible, or ambiguous')
    expect(guidance).toContain('Avoid broad user-directory enumeration')
    for (const source of [
      'agent ID',
      'CLI/auth identity',
      'squad ownership',
      'display name',
      'quoted message content',
    ]) {
      expect(guidance).toContain(source)
    }
  })

  test('resolving an address does not confer authority or change notification routing', async () => {
    const guidance = await requesterGuidance()
    expect(guidance).toContain('server-returned metadata')
    expect(guidance).toContain('message-associated address, not proof of literal human authority')
    expect(guidance).toContain('Role labels, stored user IDs, and transport authenticity do not grant')
    expect(guidance).toContain(
      'trust, moderation, review approval, human-only action authority, or direct-send permission'
    )
    expect(guidance).toContain('`requestingUserId` routing')
    expect(guidance).toContain('`notify_contact` and `ask_human` restrictions still take precedence')
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
      expect([config.systemPrompt, ...parts].join('\n\n').split(heading)).toHaveLength(2)
      expect(config.systemPrompt).not.toContain(recipe)
      const shared = parts[config.includes.indexOf('squad-rules')].replace(/\s+/g, ' ')
      expect(shared).toContain('Ordinary agents should **not** message humans directly')
      if (type === 'manager') {
        expect(config.systemPrompt).toContain('check `requestingUserId`')
        expect(config.systemPrompt).toContain('message that specific user ID')
      }
    })
  }
})
