import { join } from 'node:path'
import type { Command } from 'commander'

// Read option arity from the real CLI without parsing argv, running actions or retaining option state.
const { createProgram } = (await import(join(import.meta.dir, '../../../../cli/src/program.ts'))) as {
  createProgram: () => Command
}
const program = createProgram()
const workstream = program.commands.find((command) => command.name() === 'workstream')!

/** Collect actual reviewer flags, not flag-looking values of description/owner/other options. */
export function reviewerIds(argv: string[]): string[] {
  const command = workstream.commands.find(
    (command) => command.name() === argv[2] || command.aliases().includes(argv[2]!)
  )
  if (!command) return []
  const options = [...command.options, ...program.options]
  const reviewers: string[] = []
  for (let index = 4; index < argv.length; index++) {
    const word = argv[index]!
    const equals = word.indexOf('=')
    const flag = equals < 0 ? word : word.slice(0, equals)
    const option = options.find((option) => option.long === flag || option.short === flag)
    if (!option || (!option.required && !option.optional)) continue
    if (equals < 0 && option.optional && (!argv[index + 1] || argv[index + 1]!.startsWith('-'))) continue
    const value = equals < 0 ? argv[++index] : word.slice(equals + 1)
    if (option.long === '--reviewer' && value) reviewers.push(value)
  }
  return reviewers
}
