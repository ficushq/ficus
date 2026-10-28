import { expect, test } from 'bun:test'
import { Command } from 'commander'
import { registerSquadEnvCommands } from './squad-env'
import { registerAgentCommands } from './agent'

test('environment and agent CLI no longer expose operator secrets', () => {
  const program = new Command()
  registerSquadEnvCommands(program)
  registerAgentCommands(program)
  const env = program.commands.find((c) => c.name() === 'squad-env')!
  expect(env.commands.map((c) => c.name())).toEqual(['get', 'set', 'set-file'])
  const agent = program.commands.find((c) => c.name() === 'agent')!
  expect(agent.commands.map((c) => c.name()).filter((n) => /secret/.test(n))).toEqual([])
})
