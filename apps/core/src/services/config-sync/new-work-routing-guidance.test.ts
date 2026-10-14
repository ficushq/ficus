import { describe, expect, test } from 'bun:test'
import { readdir, readFile } from 'fs/promises'
import { join } from 'path'

const root = join(import.meta.dir, '../../../../../')
const read = (path: string) => readFile(join(root, path), 'utf8')
const include = 'new-work-routing'
// services/rbac/permissions.ts maps these types to the manager role (workstreams:create);
// every other agent type resolves to the worker role, which cannot create work streams.
const CAN_CREATE_WORK_STREAMS = new Set(['manager', 'consultant'])

async function squadAgentTypes(): Promise<Array<{ id: string; includes: string[] }>> {
  const files = (await readdir(join(root, 'config/agent-types'))).filter((file) => file.endsWith('.yaml'))
  const types = await Promise.all(
    files.map(
      async (file) => Bun.YAML.parse(await read(`config/agent-types/${file}`)) as { id: string; includes?: string[] }
    )
  )
  // Squad agents receive the shared squad rules; the routing line sits alongside them.
  return types
    .filter((type) => type.includes?.includes('squad-rules'))
    .map((type) => ({ id: type.id, includes: type.includes! }))
}

describe('new work routing guidance', () => {
  test('tells workers they cannot create work streams and what to send the manager instead', async () => {
    const guidance = (await read(`config/agent-types/shared/${include}.md`)).replace(/\s+/g, ' ')
    expect(guidance).toContain('You cannot create work streams.')
    expect(guidance).toContain('`notify_contact` or inbox')
    expect(guidance).toContain('full proposed title, description and repository settings')
    expect(guidance).toContain('tell the human it has been passed to the manager')
  })

  test('every squad worker type includes it and the manager and consultant do not', async () => {
    const types = await squadAgentTypes()
    expect(types.map((type) => type.id)).toEqual(
      expect.arrayContaining(['engineer', 'reviewer', 'manager', 'consultant'])
    )
    for (const type of types) {
      expect({ id: type.id, included: type.includes.includes(include) }).toEqual({
        id: type.id,
        included: !CAN_CREATE_WORK_STREAMS.has(type.id),
      })
    }
  })
})
