/**
 * Extract the executable argv of the shell forms used by the evals. This never executes a shell.
 * In particular, quoted evidence and CLI heredoc payloads must not turn into extra commands.
 * This is a behaviour-grading helper, not a shell security boundary or a general Bash evaluator.
 */
export function executedCommands(source: string): string[][] {
  const commands: string[][] = []
  // A heredoc is tool input, not a new command list (unless the receiver is a shell).
  source = source.replace(
    /(^[^\n]*<<-?\s*(['"]?)(\w+)\2[^\n]*\n)([\s\S]*?)^\t*\3\s*$/gm,
    (_match, opening: string, _quote: string, _delimiter: string, body: string) => {
      if (/^\s*(?:bash|sh)\b/.test(opening)) commands.push(...executedCommands(body))
      else if (!_quote) commands.push(...heredocSubstitutions(body))
      return opening
    }
  )
  let words: string[] = []
  let word = ''
  let started = false
  let quote = ''
  const flushWord = () => {
    if (started) words.push(word)
    word = ''
    started = false
  }
  const flushCommand = () => {
    flushWord()
    const argv = unwrap(words)
    words = []
    if (!argv.length) return
    if (['bash', 'sh'].includes(argv[0]!) && argv.some((arg) => /^-[a-z]*c[a-z]*$/.test(arg))) {
      const index = argv.findIndex((arg) => /^-[a-z]*c[a-z]*$/.test(arg))
      if (argv[index + 1]) commands.push(...executedCommands(argv[index + 1]!))
    } else commands.push(argv)
  }
  for (let i = 0; i < source.length; i++) {
    const ch = source[i]!
    if (quote === "'") {
      if (ch === "'") quote = ''
      else word += ch
      continue
    }
    if (ch === '\\' && i + 1 < source.length) {
      word += source[++i]
      started = true
      continue
    }
    // Command substitution executes even inside double quotes, unlike ordinary quoted prose.
    if (ch === '$' && source[i + 1] === '(') {
      const end = substitutionEnd(source, i + 2)
      commands.push(...executedCommands(source.slice(i + 2, end)))
      word += '$(...)'
      started = true
      i = end
      continue
    }
    if (ch === '`') {
      const end = source.indexOf('`', i + 1)
      if (end >= 0) {
        commands.push(...executedCommands(source.slice(i + 1, end)))
        word += '`...`'
        started = true
        i = end
        continue
      }
    }
    if (quote === '"') {
      if (ch === '"') quote = ''
      else word += ch
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      started = true
    } else if (ch === '#' && !started) {
      const end = source.indexOf('\n', i)
      i = end < 0 ? source.length : end - 1
    } else if (';|&\n()'.includes(ch)) {
      // The ampersand in a redirection is not a new executable.
      if (ch === '&' && source[i - 1] === '>') word += ch
      else flushCommand()
    } else if (/\s/.test(ch)) flushWord()
    else {
      word += ch
      started = true
    }
  }
  flushCommand()
  return commands
}

/** Unquoted heredocs expand substitutions; quoted heredocs are literal data. */
function heredocSubstitutions(body: string): string[][] {
  const commands: string[][] = []
  for (let i = 0; i < body.length; i++) {
    if (body[i] === '\\') {
      i++
      continue
    }
    if (body[i] === '$' && body[i + 1] === '(') {
      const end = substitutionEnd(body, i + 2)
      commands.push(...executedCommands(body.slice(i + 2, end)))
      i = end
    } else if (body[i] === '`') {
      const end = body.indexOf('`', i + 1)
      if (end >= 0) {
        commands.push(...executedCommands(body.slice(i + 1, end)))
        i = end
      }
    }
  }
  return commands
}

function substitutionEnd(source: string, start: number): number {
  let depth = 1
  let quote = ''
  for (let i = start; i < source.length; i++) {
    const ch = source[i]
    if (ch === '\\') {
      i++
      continue
    }
    if (quote) {
      if (ch === quote) quote = ''
      continue
    }
    if (ch === "'" || ch === '"') quote = ch
    else if (ch === '(') depth++
    else if (ch === ')' && --depth === 0) return i
  }
  return source.length
}

function unwrap(input: string[]): string[] {
  const words = [...input]
  while (words.length) {
    const first = words[0]!
    if (/^[a-zA-Z_][\w]*=/.test(first) || ['if', 'then', 'else', 'elif', 'do', '!', 'time', '{'].includes(first)) {
      words.shift()
    } else if (['env', 'exec', 'sudo', 'command'].includes(first) && !words[1]?.startsWith('-')) {
      words.shift()
    } else break
  }
  return words
}

export function hasInvocation(source: string, ...prefix: string[]): boolean {
  return executedCommands(source).some((argv) => prefix.every((word, index) => argv[index] === word))
}

/** Only actual mutation calls, never help, read-only merge-state checks, or quoted evidence. */
export function mergeInvocations(source: string): string[][] {
  return executedCommands(source).filter((argv) => {
    if (argv[0] !== 'gh' || argv.includes('--help') || argv.includes('-h')) return false
    if (argv[1] === 'pr' && argv[2] === 'merge') return true
    return (
      argv[1] === 'api' &&
      argv.some((word) => /\/pulls\/\d+\/merge$/.test(word)) &&
      (argv.includes('PUT') ||
        argv.includes('POST') ||
        argv.includes('-XPUT') ||
        argv.includes('-XPOST') ||
        argv.some((word) => word === '-f' || word === '-F' || word.startsWith('--field')))
    )
  })
}
