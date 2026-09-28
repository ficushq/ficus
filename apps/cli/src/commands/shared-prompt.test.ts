import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { Command } from 'commander'
import { apiGet, apiPost, apiPut } from '../client'
import { isJsonMode, output, outputTable, setOutputOptions } from '../output'
import { registerSharedPromptCommands } from './shared-prompt'

// `yamlFieldOverrides` is the API's list of drifted field names, not a map.
const includes = [
  { id: 'rules', name: 'Rules', description: null, disabled: false, yamlFieldOverrides: [] },
  { id: 'subagents', name: 'Subagents', description: null, disabled: true, yamlFieldOverrides: ['name'] },
]

const tempDirs: string[] = []

async function makeTempFile(content: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'tau-shared-prompt-test-'))
  tempDirs.push(dir)
  const file = join(dir, 'content.md')
  await writeFile(file, content, 'utf-8')
  return file
}

async function run(args: string[]): Promise<void> {
  const program = new Command()
  program.exitOverride()
  program.option('--json')
  program.option('--quiet')
  program.hook('preAction', (command) => setOutputOptions(command.optsWithGlobals()))
  registerSharedPromptCommands(program)
  await program.parseAsync(['--quiet', ...args], { from: 'user' })
}

describe('ficus shared-prompt', () => {
  beforeEach(() => {
    ;(apiGet as ReturnType<typeof mock>).mockClear().mockResolvedValue(includes)
    ;(apiPut as ReturnType<typeof mock>).mockClear().mockResolvedValue({ id: 'rules' })
    ;(apiPost as ReturnType<typeof mock>).mockClear().mockResolvedValue({ id: 'rules' })
    ;(output as ReturnType<typeof mock>).mockClear()
    ;(outputTable as ReturnType<typeof mock>).mockClear()
  })

  afterEach(async () => {
    mock.restore()
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  })

  it('list fetches all shared prompts and prints their ids', async () => {
    await run(['shared-prompt', 'list'])

    expect(apiGet).toHaveBeenCalledWith('/api/shared-prompts')
    // outputTable is mocked, so assert on the mock call args directly to
    // confirm the printed rows actually contain both ids.
    const rows = (outputTable as ReturnType<typeof mock>).mock.calls.at(-1)?.[0]
    expect(rows.map((r: any) => r.id)).toEqual(['rules', 'subagents'])
    // Drift comes from a non-empty field list, so an untouched prompt reads "no".
    expect(rows.map((r: any) => r.overridden)).toEqual(['no', 'yes'])
  })

  it('list passes the raw array through output unchanged in JSON mode', async () => {
    ;(isJsonMode as ReturnType<typeof mock>).mockReturnValue(true)

    await run(['shared-prompt', 'list'])

    expect(output).toHaveBeenCalledWith(includes)
    expect(outputTable).not.toHaveBeenCalled()
  })

  it('get fetches one shared prompt by id', async () => {
    ;(apiGet as ReturnType<typeof mock>).mockResolvedValue(includes[0])

    await run(['shared-prompt', 'get', 'rules'])

    expect(apiGet).toHaveBeenCalledWith('/api/shared-prompts/rules')
    expect(output).toHaveBeenCalledWith(includes[0])
  })

  it('update reads the file and PUTs its content', async () => {
    const file = await makeTempFile('New shared block content')

    await run(['shared-prompt', 'update', 'rules', '--file', file])

    expect(apiPut).toHaveBeenCalledWith('/api/shared-prompts/rules', { content: 'New shared block content' })
  })

  it('update requires --file', async () => {
    await expect(run(['shared-prompt', 'update', 'rules'])).rejects.toThrow()
  })

  it('disable posts to the disable endpoint and confirms which prompt changed', async () => {
    await run(['shared-prompt', 'disable', 'rules'])

    expect(apiPost).toHaveBeenCalledWith('/api/shared-prompts/rules/disable')
    expect(output).toHaveBeenCalledWith({ id: 'rules', disabled: true }, 'Disabled shared prompt "rules"')
  })

  it('enable posts to the enable endpoint and confirms which prompt changed', async () => {
    await run(['shared-prompt', 'enable', 'rules'])

    expect(apiPost).toHaveBeenCalledWith('/api/shared-prompts/rules/enable')
    expect(output).toHaveBeenCalledWith({ id: 'rules', enabled: true }, 'Enabled shared prompt "rules"')
  })
})
