import { expect, test } from 'bun:test'
import { Command } from 'commander'
import { registerAgentQuestionCommands } from './agent-question'

test('resolve help shows how to find the open question before relaying a human answer', () => {
  const program = new Command('ficus')
  registerAgentQuestionCommands(program)
  const group = program.commands.find((command) => command.name() === 'agent-question')!
  const resolve = group.commands.find((command) => command.name() === 'resolve')!
  let help = ''
  resolve.configureOutput({
    writeOut: (chunk) => {
      help += chunk
    },
  })
  resolve.outputHelp()
  expect(help).toContain('ficus agent-question list <your-agent-id> --status open')
  expect(help).toContain('Only the asking agent can do this')
  expect(help).toContain('--answer')
  expect(help).toContain('--source')
})
