import { describe, expect, test } from 'bun:test'
import type { Command, Option } from 'commander'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { createProgram } from './program'

// Agent guidance teaches `ficus` commands by example. When a command or flag is
// renamed or removed, the guidance silently keeps teaching it. This test reads
// every quoted `ficus ...` command in the agent-type prompts, the bundled and
// external skills, the Core prompt builders, and the notices, tool descriptions
// and errors Core sends to agents, and checks it against the real command tree.

const repoRoot = join(import.meta.dir, '..', '..', '..')

/** Directories and files whose text reaches agents. Test files are excluded. */
const GUIDANCE_SOURCES = [
  'config/agent-types',
  'config/skills',
  'external/skills',
  // Core prompt builders, runners, notices, tool descriptions and errors that
  // quote commands to agents (and operators). Shell code that only runs the
  // CLI, such as the SSH shims, is not guidance and is left out.
  'apps/core/src/lib',
  'apps/core/src/entities',
  'apps/core/src/routes',
  'apps/core/src/tools',
  'apps/core/src/services/agent-types',
  'apps/core/src/services/agents',
  'apps/core/src/services/chat',
  'apps/core/src/services/execution',
  'apps/core/src/services/fleet-alerts',
  'apps/core/src/services/integrations',
  'apps/core/src/services/recovery',
  'apps/core/src/services/slots',
  'apps/core/src/services/squad',
  'apps/core/src/services/work-streams',
  'apps/core/src/services/workflows',
]
const GUIDANCE_EXTENSIONS = /\.(md|ya?ml|ts)$/

function listFiles(path: string): string[] {
  const absolute = join(repoRoot, path)
  if (!statSync(absolute).isDirectory()) return [absolute]
  return readdirSync(absolute, { recursive: true, encoding: 'utf8' })
    .map((entry) => join(absolute, entry))
    .filter((file) => GUIDANCE_EXTENSIONS.test(file) && !file.endsWith('.test.ts') && statSync(file).isFile())
    .sort()
}

/** One quoted invocation: everything after `ficus` up to the end of the shell command. */
interface CommandReference {
  file: string
  line: number
  text: string
  /** True when the text is clearly code (a code span, code block or shell line), not prose. */
  code: boolean
}

// `ficus` as a word on its own, not part of a path, package name or identifier.
const INVOCATION = /(?<![\w./@-])ficus(?=[ \t]+[a-z<[{$'"-])/g
// The command ends at a code-span close, a shell separator or the end of the line.
const COMMAND_END = /`|\||;|&&|\$\(|\)|\n/

/** Extract `ficus ...` invocations from text, with their line numbers. */
function extractCommandReferences(file: string, source: string): CommandReference[] {
  // In TypeScript sources, code spans inside template literals are escaped. A
  // shell line continuation joins the next line; `\r` keeps the line count.
  const text = (file.endsWith('.ts') ? source.replace(/\\`/g, '`') : source).replace(/\\\n/g, ' \r')
  const references: CommandReference[] = []
  for (const match of text.matchAll(INVOCATION)) {
    const start = match.index + 'ficus'.length
    const rest = text.slice(start)
    const end = rest.search(COMMAND_END)
    const body = (end === -1 ? rest : rest.slice(0, end)).replace(/\s+/g, ' ').trim()
    const lineStart = text.lastIndexOf('\n', match.index) + 1
    const before = text.slice(lineStart, match.index)
    // Code: a code span, command substitution, a line of its own, or a chained shell command.
    const code = /`$|\$\($|^[\s>$#-]*$|(?:&&|\||;)\s*$/.test(before)
    references.push({
      file: relative(repoRoot, file),
      line: text.slice(0, match.index).split(/[\n\r]/).length,
      text: body,
      code,
    })
  }
  return references
}

/** Split a command into shell words, keeping quoted arguments whole. */
function shellWords(text: string): string[] {
  return text.match(/(?:[^\s'"]+|'[^']*'?|"[^"]*"?)+/g) ?? []
}

const isPlaceholder = (word: string) => /^[<[{$'"*.]/.test(word) || word.includes('...') || word === '…'

function findSubcommand(command: Command, word: string): Command | undefined {
  return command.commands.find((child) => child.name() === word || child.aliases().includes(word))
}

function optionNames(command: Command): Set<string> {
  const names = new Set(['--help', '-h'])
  for (const option of command.options as Option[]) {
    if (option.long) names.add(option.long)
    if (option.short) names.add(option.short)
  }
  return names
}

const commandPath = (command: Command): string => {
  const names: string[] = []
  for (let current: Command | null = command; current?.parent; current = current.parent) names.unshift(current.name())
  return ['ficus', ...names].join(' ')
}

/** Literal text that contains the word `ficus` but is not a command, with the reason. */
const NOT_COMMANDS = new Map([
  ['remote hosts >>>', 'marker line of the managed block in the squad SSH config'],
  ['remote hosts <<<', 'marker line of the managed block in the squad SSH config'],
])

/**
 * Check one invocation against the command tree. Returns a problem description,
 * or null when the command and every flag exist.
 */
function checkCommandReference(program: Command, reference: CommandReference): string | null {
  if (NOT_COMMANDS.has(reference.text)) return null
  const words = shellWords(reference.text)
  let command = program
  let index = 0
  for (; index < words.length; index++) {
    const raw = words[index]!
    if (raw.startsWith('-')) break
    // Prose punctuation after a command name, as in "run `ficus workstream finish`."
    const word = raw.replace(/[.,:;!?'"})]+$/, '')
    if (isPlaceholder(word) || !/^[a-z][a-z0-9-]*(?:\/[a-z][a-z0-9-]*)*$/.test(word)) {
      // An unknown subcommand: flags cannot be checked against anything.
      if (command.commands.length > 0) return null
      break
    }
    if (word === 'help' && (command.commands.length > 0 || command === program)) return null
    if (word.includes('/') && command.commands.length > 0) {
      // Alternatives such as `ficus workstream pause/resume`: each must exist.
      const missing = word.split('/').filter((name) => !findSubcommand(command, name))
      if (missing.length === 0) return null
      return `\`${commandPath(command)}\` has no subcommand \`${missing.join('`, `')}\``
    }
    const child = findSubcommand(command, word)
    if (child) {
      command = child
      if (word !== raw) break
      continue
    }
    // Prose such as "the ficus binary" never resolved to a command in the first place.
    if (command === program && !reference.code) return null
    // A command with subcommands but no action of its own rejects anything else.
    const hasAction = (command as unknown as { _actionHandler: unknown })._actionHandler != null
    if (command.commands.length > 0 && !hasAction) return `\`${commandPath(command)}\` has no subcommand \`${word}\``
    break
  }
  if (command === program) return null

  // Only the command's own options are checked. That covers --json, --quiet and --backend
  // because configureGlobalOptionScope copies those global options onto every command.
  const known = optionNames(command)
  for (const word of words.slice(index)) {
    if (/^--?[A-Za-z]/.test(word)) {
      const flag = word.split('=')[0]!.replace(/[.,:]+$/, '')
      if (!known.has(flag)) return `\`${commandPath(command)}\` has no option \`${flag}\``
    }
    // Prose after an unquoted command: stop at the end of the clause.
    if (!reference.code && /[.,:]$/.test(word)) break
  }
  return null
}

/**
 * Known stale references that another change is already rewriting, keyed by
 * file and problem. Each entry must still occur, so it is removed with the fix.
 */
const KNOWN_STALE = new Map<string, string>()

const reference = (text: string, code = true): CommandReference => ({ file: 'example.md', line: 1, text, code })

describe('the command reference checker', () => {
  const program = createProgram()
  const check = (text: string, code = true) => checkCommandReference(program, reference(text, code))

  test('accepts existing commands, aliases, flags and placeholders', () => {
    expect(check('squad create "Team" -p "Purpose" --preset engineering')).toBeNull()
    expect(check('ws flow <id> --json')).toBeNull()
    expect(check('workstream <command> --help')).toBeNull()
    expect(check('workflow list/get.')).toBeNull()
    expect(check('channel update <id> --channel-squad-map \'{"C1": "<squad-id>"}\'')).toBeNull()
  })

  test('rejects unknown subcommands and flags', () => {
    expect(check('squad create "Team" -p "Purpose" -t engineering')).toBe('`ficus squad create` has no option `-t`')
    expect(check('channel link-squad my-channel <squad-id>')).toBe('`ficus channel` has no subcommand `link-squad`')
    expect(check('workstream pause/rewind')).toBe('`ficus workstream` has no subcommand `rewind`')
    expect(check('nonexistent list')).toBe('`ficus` has no subcommand `nonexistent`')
  })

  test('ignores prose that never named a command', () => {
    expect(check('binary is installed', false)).toBeNull()
    const text =
      'Run `ficus squad list`.\nThe /ficus help slash command.\n```bash\nficus squad create "A" \\\n  --preset engineering\n```'
    expect(extractCommandReferences(join(repoRoot, 'example.md'), text)).toEqual([
      { file: 'example.md', line: 1, text: 'squad list', code: true },
      { file: 'example.md', line: 4, text: 'squad create "A" --preset engineering', code: true },
    ])
  })
})

describe('ficus commands quoted in agent guidance', () => {
  const program = createProgram()
  const references = GUIDANCE_SOURCES.flatMap(listFiles).flatMap((file) =>
    extractCommandReferences(file, readFileSync(file, 'utf8'))
  )
  const problems = references.flatMap((reference) => {
    const problem = checkCommandReference(program, reference)
    return problem
      ? [
          {
            key: `${reference.file}: ${problem}`,
            at: `${reference.file}:${reference.line}: ficus ${reference.text}`,
            problem,
          },
        ]
      : []
  })

  test('the guidance sources contain quoted commands to check', () => {
    expect(references.length).toBeGreaterThan(200)
  })

  test('every quoted command and flag exists in the CLI command tree', () => {
    const unexpected = problems
      .filter(({ key }) => !KNOWN_STALE.has(key))
      .map(({ at, problem }) => `${at}\n    ${problem}`)
    expect(unexpected).toEqual([])
  })

  test('every known stale reference still occurs (remove the entry once it is fixed)', () => {
    const found = new Set(problems.map(({ key }) => key))
    expect([...KNOWN_STALE.keys()].filter((key) => !found.has(key))).toEqual([])
  })
})
