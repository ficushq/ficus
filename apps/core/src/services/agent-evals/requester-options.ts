import { join } from 'node:path'
import type { Command } from 'commander'

const { createProgram } = (await import(join(import.meta.dir, '../../../../cli/src/program.ts'))) as {
  createProgram: () => Command
}

/**
 * Parse options and operands with the real CLI, without parsing actions or making API calls.
 * Use a fresh tree for each invocation so collected option values cannot leak between runs.
 */
export function parseRequesterCommand(
  argv: string[]
): { action: string; target: string | undefined; reviewers: string[]; clearReviewers: boolean } | undefined {
  if (argv[0] !== 'ficus') return undefined
  const program = createProgram()
  let index = 1
  // Root options can precede the group. Their values are not group or action names.
  while (argv[index]?.startsWith('-')) {
    const word = argv[index]!
    const flag = word.split('=')[0]
    const option = program.options.find((option) => option.long === flag || option.short === flag)
    if (!option) return undefined
    index++
    if ((option.required || option.optional) && !word.includes('=')) {
      if (!argv[index] || (option.optional && argv[index]!.startsWith('-'))) {
        if (option.required) return undefined
      } else index++
    }
  }
  const group = program.commands.find(
    (command) => command.name() === argv[index] || command.aliases().includes(argv[index]!)
  )
  if (group?.name() !== 'workstream') return undefined
  const action = argv[index + 1]
  const command = group.commands.find((command) => command.name() === action || command.aliases().includes(action!))
  if (!command) return undefined
  command.exitOverride().configureOutput({ writeOut: () => {}, writeErr: () => {} })
  try {
    const { operands, unknown } = command.parseOptions(argv.slice(index + 2))
    if (unknown.length || operands.length < command.registeredArguments.filter((argument) => argument.required).length)
      return undefined
    const reviewers: string[] = command.opts().reviewer ?? []
    const clearReviewers = command.opts().clearReviewers === true
    if (clearReviewers && reviewers.length) return undefined
    return { action: command.name(), target: operands[0], reviewers, clearReviewers }
  } catch {
    // Invalid options or missing option values are not successful fixture operations.
    return undefined
  }
}
