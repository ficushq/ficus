import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { Command } from 'commander'
import { apiGet, apiPut } from '../client'
import { outputTable, setOutputOptions } from '../output'
import { registerAgentTypeCommands } from './agent-type'

const existing = {
  id: 'engineer',
  name: 'Engineer',
  model: '',
  description: 'Writes code',
  systemPrompt: 'You implement.',
  includes: ['rules', 'subagents', 'squad-rules'],
  skills: ['test-driven-development'],
  extensions: null,
  toolsAllow: null,
  toolsDeny: null,
}

const sysops = {
  id: 'sysops',
  name: 'Sysops',
  model: '',
  description: 'Runs the fleet',
  systemPrompt: 'You operate.',
  resolvedSystemPrompt: 'You operate.\n\n## Rules\n\nFollow the rules.',
  includes: ['rules'],
  skills: null,
  extensions: null,
  toolsAllow: null,
  toolsDeny: null,
}

describe('ficus agent-type update', () => {
  beforeEach(() => {
    ;(apiGet as ReturnType<typeof mock>).mockResolvedValue(existing)
    ;(apiPut as ReturnType<typeof mock>).mockClear()
    ;(apiPut as ReturnType<typeof mock>).mockResolvedValue(existing)
  })

  afterEach(() => {
    mock.restore()
  })

  async function run(args: string[]): Promise<void> {
    const program = new Command()
    program.exitOverride()
    program.option('--json')
    program.option('--quiet')
    program.hook('preAction', (command) => setOutputOptions(command.optsWithGlobals()))
    registerAgentTypeCommands(program)
    await program.parseAsync(['--quiet', ...args], { from: 'user' })
  }

  // The PUT replaces the whole row, so a rebuilt body that drops `includes`
  // would strip the type's shared prompt blocks on any unrelated edit.
  it('carries the existing include list into the update body', async () => {
    await run(['agent-type', 'update', 'engineer', '--description', 'Writes better code'])

    expect(apiPut).toHaveBeenCalledWith(
      '/api/agent-types/engineer',
      expect.objectContaining({
        description: 'Writes better code',
        includes: ['rules', 'subagents', 'squad-rules'],
      })
    )
  })

  it('sends an empty list for a type that has no includes', async () => {
    ;(apiGet as ReturnType<typeof mock>).mockResolvedValue({ ...existing, includes: null })

    await run(['agent-type', 'update', 'engineer', '--name', 'Engineer II'])

    expect(apiPut).toHaveBeenCalledWith('/api/agent-types/engineer', expect.objectContaining({ includes: [] }))
  })
})

describe('ficus agent-type get --resolved', () => {
  beforeEach(() => {
    ;(apiGet as ReturnType<typeof mock>).mockResolvedValue(sysops)
  })

  afterEach(() => {
    mock.restore()
  })

  async function run(args: string[]): Promise<string[]> {
    const program = new Command()
    program.exitOverride()
    program.option('--json')
    program.option('--quiet')
    program.hook('preAction', (command) => setOutputOptions(command.optsWithGlobals()))
    registerAgentTypeCommands(program)

    const printed: string[] = []
    const realLog = console.log
    console.log = (line?: unknown) => void printed.push(String(line))
    try {
      await program.parseAsync(['--quiet', ...args], { from: 'user' })
    } finally {
      console.log = realLog
    }
    return printed
  }

  it('prints only the resolved system prompt text', async () => {
    const printed = await run(['agent-type', 'get', 'sysops', '--resolved'])

    expect(printed).toEqual(['You operate.\n\n## Rules\n\nFollow the rules.'])
  })

  it('falls back to systemPrompt when resolvedSystemPrompt is absent', async () => {
    ;(apiGet as ReturnType<typeof mock>).mockResolvedValue({ ...sysops, resolvedSystemPrompt: undefined })

    const printed = await run(['agent-type', 'get', 'sysops', '--resolved'])

    expect(printed).toEqual(['You operate.'])
  })
})

describe('ficus agent-type list', () => {
  beforeEach(() => {
    ;(apiGet as ReturnType<typeof mock>).mockResolvedValue([existing, { ...sysops, includes: null }])
    ;(outputTable as ReturnType<typeof mock>).mockClear()
  })

  afterEach(() => {
    mock.restore()
  })

  async function run(args: string[]): Promise<void> {
    const program = new Command()
    program.exitOverride()
    program.option('--json')
    program.option('--quiet')
    program.hook('preAction', (command) => setOutputOptions(command.optsWithGlobals()))
    registerAgentTypeCommands(program)
    await program.parseAsync(['--quiet', ...args], { from: 'user' })
  }

  // The shared prompts a type composes are part of what it is, so `list` shows
  // them; a type with none prints an empty cell rather than "null".
  it("prints each type's shared prompt list in an includes column", async () => {
    await run(['agent-type', 'list'])

    expect(apiGet).toHaveBeenCalledWith('/api/agent-types')
    const [rows, columns] = (outputTable as ReturnType<typeof mock>).mock.calls.at(-1)!
    expect(columns).toContain('includes')
    expect(rows.map((row: any) => row.includes)).toEqual(['rules,subagents,squad-rules', ''])
  })
})
