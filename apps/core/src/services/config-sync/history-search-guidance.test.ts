import { describe, expect, test } from 'bun:test'
import { readdir, readFile } from 'fs/promises'
import { join } from 'path'

const root = join(import.meta.dir, '../../../../../')
const read = (path: string) => readFile(join(root, path), 'utf8')
const line = 'Messages and tool output survive compaction: `ficus agent search {{agent.id}} <query>`.'

describe('history search guidance', () => {
  test('squad rules name the shipped command once, right after the requester identity rule', async () => {
    const shared = (await read('config/agent-types/shared/squad-rules.md')).replace(/[ \n]+/g, ' ')
    expect(shared.split('ficus agent search')).toHaveLength(2)
    expect(shared.split(line)).toHaveLength(2)
    // Its own paragraph after the requester identity rule, which stays unchanged.
    expect(shared).toContain(`restrictions still apply. ${line} ### Sending Messages`)
    // The command is the one the CLI registers.
    const cli = await read('apps/cli/src/commands/agent-search.ts')
    expect(cli).toContain(".command('search <id> <query...>')")
  })

  test('only agent types that keep a shell include it', async () => {
    const dir = join(root, 'config/agent-types')
    const files = (await readdir(dir)).filter((name) => name.endsWith('.yaml'))
    const including: string[] = []
    for (const file of files) {
      const config = Bun.YAML.parse(await readFile(join(dir, file), 'utf8')) as {
        includes?: string[]
        tools?: { allow?: string[]; deny?: string[] }
      }
      if (!config.includes?.includes('squad-rules')) continue
      including.push(file)
      const allow = config.tools?.allow
      const deny = config.tools?.deny ?? []
      const shells = ['bash', 'squad_bash'].filter((name) => (!allow || allow.includes(name)) && !deny.includes(name))
      expect({ file, shells: shells.length > 0 }).toEqual({ file, shells: true })
    }
    expect(including.length).toBeGreaterThan(0)
  })
})
