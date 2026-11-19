import { expect, test } from 'bun:test'
import { Command } from 'commander'
import { cliHelpFor } from './tools'

function programWithGuidance() {
  const program = new Command('ficus').addHelpText('afterAll', 'ANCESTOR_GUIDANCE')
  program
    .command('example')
    .alias('ex')
    .description('Example command')
    .option('--value <text>', 'Example option')
    .addHelpText('after', 'POINT_OF_USE_GUIDANCE')
  return program
}

test('help captures after-help text, command options and aliases without leaking or retaining output', () => {
  const program = programWithGuidance()
  const command = program.commands[0]!
  const leaked: string[] = []
  command.configureOutput({ writeOut: (text) => leaked.push(text), writeErr: (text) => leaked.push(text) })
  const before = { ...command.configureOutput() }
  for (const source of [
    'ficus example --help',
    'ficus ex -h',
    'ficus help example',
    'ficus example --value text --help',
  ]) {
    const help = cliHelpFor(program, source)!
    expect(help).toContain('POINT_OF_USE_GUIDANCE')
    expect(help).toContain('--value <text>')
    expect(help).toContain('Example command')
    expect(help).toContain('ANCESTOR_GUIDANCE')
    expect(help.match(/POINT_OF_USE_GUIDANCE/g)).toHaveLength(1)
    expect(command.configureOutput()).toEqual(before)
  }
  expect(leaked).toEqual([])
  command.outputHelp()
  expect(leaked.join('')).toContain('POINT_OF_USE_GUIDANCE')
})

test('help restores output configuration even if an after-help listener throws', () => {
  const program = programWithGuidance()
  const command = program.commands[0]!
  const before = { ...command.configureOutput() }
  command.on('afterHelp', () => {
    throw new Error('listener failed')
  })
  expect(() => cliHelpFor(program, 'ficus example --help')).toThrow('listener failed')
  expect(command.configureOutput()).toEqual(before)
})

test('unknown and quoted help requests do not impersonate allowed commands', () => {
  const program = programWithGuidance()
  expect(cliHelpFor(program, 'ficus unknown --help')).toBeUndefined()
  expect(cliHelpFor(program, 'echo "ficus example --help"')).toBeUndefined()
  expect(cliHelpFor(program, 'ficus example --value hello')).toBeUndefined()
})

test('help cannot reveal a forbidden command or its after-help guidance through aliases or parent help', () => {
  const program = new Command('ficus')
  const group = program.command('workstream').alias('ws')
  group.command('create').alias('new').addHelpText('after', 'PRIVATE_MARKER')
  group.command('flow').description('Inspect flow')
  const children = group.commands
  for (const source of ['ficus workstream create --help', 'ficus ws new -h', 'ficus help ws create'])
    expect(cliHelpFor(program, source, ['workstreams:respond'])).toBeUndefined()
  const help = cliHelpFor(program, 'ficus ws --help', ['workstreams:respond'])!
  expect(help).toContain('flow')
  expect(help).not.toContain('create')
  expect(help).not.toContain('PRIVATE_MARKER')
  expect(group.commands).toBe(children)
  expect(cliHelpFor(program, 'ficus ws new --help', ['*'])).toContain('PRIVATE_MARKER')
})

test('real permitted CLI help retains command and option documentation', async () => {
  const { createProgram } = await import('../../../../cli/src/program')
  const program = createProgram()
  expect(cliHelpFor(program, 'ficus workstream request-input --help', ['workstreams:respond'])).toContain('--stdin')
  expect(cliHelpFor(program, 'ficus slot claim --help', ['workstreams:respond'])).toContain('Usage: ficus slot claim')
})
