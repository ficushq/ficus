/**
 * Which shell commands fetch content from outside the instance, for the tool result firewall.
 *
 * Most bash calls (builds, tests, git, file edits) print only our own output and must not be screened:
 * screening costs a decision-model call and every flag is a chance of a false positive. So a command is
 * screened only when one of its simple commands is a known fetcher:
 * - `gh` reading GitHub content: `issue view|list`, `pr view|list|diff|checks`, `api`, `search`,
 *   `release view|list`, `repo view`, `run view` (job logs are text too) and `gist view`. Writes
 *   (`gh pr create`, `gh issue comment`, `gh auth …`) print our own text, so they are not screened.
 * - HTTP clients: `curl`, `wget`, httpie (`http`, `https`), `xh`/`xhs` and `aria2c`, unless every URL
 *   they name is on this machine (localhost, 127.0.0.1, ::1): that is our own dev server.
 * - Text browsers dumping a page: `lynx`, `w3m`, `links` and `elinks` with `-dump` or `-source`.
 *
 * Deliberately left out, as too broad or too rarely external:
 * - `git clone`/`fetch`/`pull` print progress only, and `git log`/`git show` of a fetched branch can't be
 *   told apart from local history without the repository's state.
 * - `npx`/`bunx`/`python -c`/`node -e` running a fetcher: we can't know what a package or script does.
 * - `ssh host cmd`, `nc`, `docker run`, `kubectl logs`: remote or container output, not fetched content.
 * - Content a fetch saved to a file and a later command reads (`curl -o f …; cat f` in separate calls).
 *   Both in one command are screened, since the curl matches.
 *
 * The parser is deliberately small: it splits a command on `|`, `||`, `&&`, `;`, `&`, newlines,
 * subshells, `$(…)`, backticks and process substitutions, honours quotes, skips redirections, comments
 * and here-document bodies, and looks at each piece's leading command after variable assignments,
 * shell keywords and wrappers (`env`, `sudo`, `time`, `timeout`, `xargs`, …). `bash -c '…'`, `sh -c`
 * and `eval` are parsed recursively.
 */

/** A matched command's source, as data for the decision model and the firewall's notice. */
export interface ShellFetch {
  /** A short description, such as `gh issue view 123 (owner/repo)` or `curl example.com/path`. */
  source: string
}

export const SHELL_FETCH_SOURCE_MAX = 200
const MAX_DEPTH = 3

/** Whether a shell command fetches content from outside the instance, and from where. */
export function fetchesOutsideContent(command: string): ShellFetch | null {
  const sources = findSources(command, 0)
  if (!sources.length) return null
  const unique = [...new Set(sources)]
  return { source: truncate(unique.join(', '), SHELL_FETCH_SOURCE_MAX) }
}

function findSources(command: string, depth: number): string[] {
  if (depth > MAX_DEPTH || !command.trim()) return []
  return splitSimpleCommands(command).flatMap((words) => {
    const command = leadingCommand(words)
    return command ? matchCommand(command.argv, depth, command.viaXargs) : []
  })
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`
}

// ---------------------------------------------------------------------------------------------------
// Splitting a command into simple commands (each a list of words)

type Frame = {
  close: ')' | '`'
  resume: 'none' | 'dq'
  /** `$(…)` or backticks: their output becomes part of the word around them. */
  substitution: boolean
  words: string[]
  word: string | null
}

/** The simple commands in a shell command line, as words with quotes removed. Exported for tests. */
export function splitSimpleCommands(command: string): string[][] {
  const segments: string[][] = []
  const stack: Frame[] = []
  let words: string[] = []
  let word: string | null = null
  let quote: 'none' | 'sq' | 'dq' = 'none'
  /** What the next word is: a redirection's target or a here-document's delimiter (both dropped). */
  let skipNext: 'redirect' | 'heredoc' | 'heredoc-strip' | null = null
  const heredocs: Array<{ delimiter: string; strip: boolean }> = []

  const endWord = () => {
    if (word === null) return
    if (skipNext === 'heredoc' || skipNext === 'heredoc-strip')
      heredocs.push({ delimiter: word, strip: skipNext === 'heredoc-strip' })
    else if (skipNext !== 'redirect') words.push(word)
    skipNext = null
    word = null
  }
  const endSegment = () => {
    endWord()
    if (words.length) segments.push(words)
    words = []
  }
  const push = (close: Frame['close'], resume: Frame['resume'], substitution: boolean) => {
    stack.push({ close, resume, substitution, words, word })
    words = []
    word = null
    quote = 'none'
  }
  const pop = () => {
    endSegment()
    const frame = stack.pop()!
    words = frame.words
    // Keep a placeholder, so `curl $(cat url.txt)` still has a URL, if not a known one.
    word = frame.substitution ? `${frame.word ?? ''}$(…)` : frame.word
    quote = frame.resume
  }

  let i = 0
  const at = (offset = 0) => command[i + offset] ?? ''
  while (i < command.length) {
    const c = at()
    if (quote === 'sq') {
      if (c === "'") quote = 'none'
      else word += c
      i++
      continue
    }
    if (quote === 'dq') {
      if (c === '"') quote = 'none'
      else if (c === '\\' && '$`"\\\n'.includes(at(1))) {
        if (at(1) !== '\n') word += at(1)
        i++
      } else if (c === '$' && at(1) === '(') {
        push(')', 'dq', true)
        i++
      } else if (c === '`') push('`', 'dq', true)
      else word += c
      i++
      continue
    }

    if (c === ' ' || c === '\t' || c === '\r') {
      endWord()
      i++
    } else if (c === '\n') {
      endSegment()
      i++
      // Here-document bodies start on the next line and are data, not commands.
      for (const { delimiter, strip } of heredocs.splice(0)) {
        while (i < command.length) {
          const end = command.indexOf('\n', i)
          const line = command.slice(i, end === -1 ? command.length : end)
          i = end === -1 ? command.length : end + 1
          if ((strip ? line.replace(/^\t+/, '') : line) === delimiter) break
        }
      }
    } else if (c === '\\') {
      if (at(1) !== '\n') word = (word ?? '') + at(1)
      i += 2
    } else if (c === "'" || c === '"') {
      word ??= ''
      quote = c === "'" ? 'sq' : 'dq'
      i++
    } else if (c === '#' && word === null) {
      while (i < command.length && at() !== '\n') i++
    } else if (c === '$' && at(1) === '(') {
      push(')', 'none', true)
      i += 2
    } else if (c === '`') {
      if (stack.at(-1)?.close === '`') pop()
      else push('`', 'none', true)
      i++
    } else if (c === '(') {
      endWord()
      push(')', 'none', false)
      i++
    } else if (c === ')') {
      if (stack.at(-1)?.close === ')') pop()
      else endSegment()
      i++
    } else if (c === '|' || c === ';') {
      endSegment()
      i += at(1) === c || (c === '|' && at(1) === '&') ? 2 : 1
    } else if (c === '&') {
      if (at(1) === '>') {
        endWord()
        skipNext = 'redirect'
        i += at(2) === '>' ? 3 : 2
      } else {
        endSegment()
        i += at(1) === '&' ? 2 : 1
      }
    } else if (c === '<' || c === '>') {
      // A file descriptor number right before the operator belongs to it (`2>&1`).
      if (word !== null && /^\d+$/.test(word) && skipNext === null) word = null
      else endWord()
      if (at(1) === '(') {
        push(')', 'none', false)
        i += 2
      } else if (c === '<' && command.startsWith('<<<', i)) {
        skipNext = 'redirect'
        i += 3
      } else if (c === '<' && at(1) === '<') {
        skipNext = at(2) === '-' ? 'heredoc-strip' : 'heredoc'
        i += at(2) === '-' ? 3 : 2
      } else if (at(1) === '&') {
        i += 2
        if (/[\d-]/.test(at())) while (/[\d-]/.test(at())) i++
        else skipNext = 'redirect'
      } else {
        skipNext = 'redirect'
        i += at(1) === '>' || at(1) === '|' || (c === '<' && at(1) === '>') ? 2 : 1
      }
    } else {
      word = (word ?? '') + c
      i++
    }
  }
  endSegment()
  // Unclosed substitutions: what was before them is still a command.
  while (stack.length) {
    const frame = stack.pop()!
    words = frame.words
    word = frame.word
    endSegment()
  }
  return segments
}

// ---------------------------------------------------------------------------------------------------
// Finding the command a simple command runs

/** Words that come before a command without being one. */
const SHELL_KEYWORDS = new Set(['!', '{', '}', 'then', 'do', 'else', 'elif', 'if', 'while', 'until'])

/** Commands that run another command, with their flags that take a value, and positionals to skip. */
const WRAPPERS: Record<string, { valueFlags: string[]; positionals?: number }> = {
  env: { valueFlags: ['-u', '--unset', '-C', '--chdir'] },
  sudo: { valueFlags: ['-u', '-g', '-C', '-D', '-h', '-p', '-r', '-t', '-U', '-T', '--user', '--group'] },
  doas: { valueFlags: ['-u', '-C'] },
  time: { valueFlags: ['-f', '-o', '--format', '--output'] },
  nice: { valueFlags: ['-n', '--adjustment'] },
  nohup: { valueFlags: [] },
  timeout: { valueFlags: ['-s', '--signal', '-k', '--kill-after'], positionals: 1 },
  command: { valueFlags: [] },
  exec: { valueFlags: ['-a'] },
  xargs: { valueFlags: ['-I', '-n', '-P', '-L', '-d', '-E', '-s', '-a', '--max-args', '--max-procs'] },
  stdbuf: { valueFlags: ['-i', '-o', '-e'] },
}

const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh'])

function basename(word: string): string {
  return word.slice(word.lastIndexOf('/') + 1)
}

/** The command and its arguments, past assignments, keywords and wrappers; null when there is none. */
function leadingCommand(words: string[]): { argv: string[]; viaXargs: boolean } | null {
  let i = 0
  let viaXargs = false
  while (i < words.length) {
    const word = words[i]!
    if (/^[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\])?\+?=/.test(word) || SHELL_KEYWORDS.has(word)) {
      i++
      continue
    }
    const name = basename(word)
    const wrapper = WRAPPERS[name]
    if (!wrapper) return { argv: words.slice(i), viaXargs }
    if (name === 'xargs') viaXargs = true
    i++
    // `command -v curl` looks a command up; it doesn't run it.
    if (name === 'command' && /^-[a-zA-Z]*[vV]/.test(words[i] ?? '')) return null
    while (i < words.length && words[i]!.startsWith('-') && words[i] !== '-') {
      const flag = words[i]!
      i += 1
      if (flag === '--') break
      if (wrapper.valueFlags.includes(flag)) i += 1
    }
    i += wrapper.positionals ?? 0
  }
  return null
}

// ---------------------------------------------------------------------------------------------------
// Matching fetchers

const HTTP_CLIENTS = new Set(['curl', 'wget', 'http', 'https', 'xh', 'xhs', 'aria2c'])
const TEXT_BROWSERS = new Set(['lynx', 'w3m', 'links', 'elinks'])
const DUMP_FLAGS = new Set(['-dump', '--dump', '-source', '--source', '-dump_source'])

/** `viaXargs`: the command's arguments (such as URLs) also come from its input. */
function matchCommand(argv: string[], depth: number, viaXargs = false): string[] {
  const name = basename(argv[0]!)
  const args = argv.slice(1)
  if (SHELLS.has(name)) {
    const flag = args.findIndex((arg) => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(arg))
    const script = flag === -1 ? undefined : args.slice(flag + 1).find((arg) => !arg.startsWith('-'))
    return script ? findSources(script, depth + 1) : []
  }
  if (name === 'eval') return findSources(args.join(' '), depth + 1)
  if (name === 'gh') {
    const source = ghSource(args)
    return source ? [source] : []
  }
  if (HTTP_CLIENTS.has(name)) {
    const source = httpSource(name, args, viaXargs)
    return source ? [source] : []
  }
  if (TEXT_BROWSERS.has(name) && args.some((arg) => DUMP_FLAGS.has(arg))) {
    const source = httpSource(name, args)
    return source ? [source] : []
  }
  return []
}

/** gh commands that print content from GitHub; `'any'` for every subcommand. */
const GH_READS: Record<string, 'any' | readonly string[]> = {
  api: 'any',
  search: 'any',
  issue: ['view', 'list', 'ls'],
  pr: ['view', 'list', 'ls', 'diff', 'checks'],
  release: ['view', 'list', 'ls'],
  repo: ['view'],
  run: ['view'],
  gist: ['view'],
}

/** gh flags (on the reading commands) that take a separate value. */
const GH_VALUE_FLAGS = new Set([
  '-R',
  '--repo',
  '--hostname',
  '-q',
  '--jq',
  '-t',
  '--template',
  '--json',
  '-H',
  '--header',
  '-X',
  '--method',
  '-f',
  '-F',
  '--field',
  '--raw-field',
  '-L',
  '--limit',
  '-s',
  '--state',
  '-A',
  '--author',
  '-a',
  '--assignee',
  '-l',
  '--label',
  '-S',
  '--search',
  '-B',
  '--base',
  '--head',
  '-m',
  '--milestone',
  '-j',
  '--job',
  '--attempt',
  '--input',
  '-p',
  '--preview',
])

function ghSource(args: string[]): string | null {
  const positionals: string[] = []
  let repo: string | null = null
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (arg === '--') {
      positionals.push(...args.slice(i + 1))
      break
    }
    if (arg.startsWith('-') && arg !== '-') {
      const [flag, inline] = arg.includes('=')
        ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)]
        : [arg]
      if (flag === '-R' || flag === '--repo') repo = inline ?? args[i + 1] ?? null
      else if (/^-R./.test(arg)) repo = arg.slice(2)
      if (inline === undefined && GH_VALUE_FLAGS.has(flag!)) i++
      continue
    }
    positionals.push(arg)
  }
  const [group, action] = positionals
  const reads = group ? GH_READS[group] : undefined
  if (!reads || (reads !== 'any' && !(action && reads.includes(action)))) return null
  return `gh ${positionals.slice(0, 4).join(' ')}${repo ? ` (${repo})` : ''}`
}

const LOOPBACK = /^(localhost|.+\.localhost|127(\.\d{1,3}){3}|0\.0\.0\.0|\[?::1\]?)$/i

/** An argument's host and path when it names a URL (with or without a scheme). */
function parseTarget(arg: string, name: string): { host: string; path: string; schemed: boolean } | null {
  let raw = arg
  const schemed = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw)
  if (!schemed) {
    // httpie and xh: `:3000/path` is localhost.
    if ((name === 'http' || name === 'https' || name === 'xh' || name === 'xhs') && /^:(\d|\/)/.test(raw))
      raw = `localhost${raw}`
    if (!/^(localhost|[a-z0-9-]+(\.[a-z0-9-]+)+|\[[0-9a-f:]+\])(:\d+)?([/?#]|$)/i.test(raw)) return null
    raw = `http://${raw}`
  }
  try {
    const url = new URL(raw)
    if (!url.hostname) return null
    // Never the query (it can carry tokens) or credentials: only where it is.
    return { host: url.host, path: url.pathname === '/' ? '' : safeDecode(url.pathname), schemed }
  } catch {
    return null
  }
}

/** Each client's flags whose separate value is not the URL (a file, a header, a body, a proxy…). */
const CLIENT_VALUE_FLAGS: Record<string, readonly string[]> = {
  curl: [
    ...['-o', '--output', '-d', '--data', '--data-raw', '--data-binary', '--data-urlencode', '--json'],
    ...['-H', '--header', '-u', '--user', '-X', '--request', '-A', '--user-agent', '-e', '--referer'],
    ...['-b', '--cookie', '-c', '--cookie-jar', '-T', '--upload-file', '-F', '--form', '-w', '--write-out'],
    ...['-K', '--config', '-x', '--proxy', '--resolve', '--connect-to', '-m', '--max-time', '--retry'],
    ...['-r', '--range', '-E', '--cert', '--key', '--cacert', '-D', '--dump-header'],
  ],
  wget: [
    ...['-O', '--output-document', '-o', '--output-file', '-a', '--append-output', '-P', '--directory-prefix'],
    ...['-U', '--user-agent', '--header', '-e', '--execute', '-t', '--tries', '-T', '--timeout', '--user'],
    ...['--password', '--post-data', '--post-file', '-i', '--input-file'],
  ],
  aria2c: ['-d', '--dir', '-o', '--out', '-x', '-s', '-j', '-i', '--input-file'],
  http: ['-a', '--auth', '-o', '--output', '--session', '--proxy', '--verify', '--cert'],
  xh: ['-a', '--auth', '-o', '--output', '--session', '--proxy', '--verify', '--cert'],
}
CLIENT_VALUE_FLAGS.https = CLIENT_VALUE_FLAGS.http!
CLIENT_VALUE_FLAGS.xhs = CLIENT_VALUE_FLAGS.xh!

function safeDecode(path: string): string {
  try {
    return decodeURI(path)
  } catch {
    return path
  }
}

function httpSource(name: string, args: string[], viaXargs = false): string | null {
  const valueFlags = CLIENT_VALUE_FLAGS[name] ?? []
  const operands: string[] = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (arg === '--url') {
      if (args[i + 1] !== undefined) operands.push(args[++i]!)
    } else if (arg.startsWith('--url=')) operands.push(arg.slice(6))
    else if (arg.startsWith('-') && arg !== '-') {
      if (valueFlags.includes(arg)) i++
    } else operands.push(arg)
  }
  // Nothing to fetch (`curl --version`, `wget --help`), unless xargs passes the URLs.
  if (!operands.length) return viaXargs ? name : null
  const targets = operands.map((arg) => parseTarget(arg, name)).filter((target) => target !== null)
  const preferred = targets.some((target) => target.schemed) ? targets.filter((target) => target.schemed) : targets
  // Only this machine: our own dev server or API, not outside content. A URL in a variable could be anywhere.
  const local = (target: { host: string }) => LOOPBACK.test(target.host.replace(/:\d+$/, ''))
  if (preferred.length && preferred.every(local) && !operands.some((arg) => arg.includes('$'))) return null
  const target = preferred[0]
  if (target) return `${name} ${target.host}${target.path}`
  // A URL in a variable can't be resolved here, so it is screened; name the variable, not its value.
  const variable = operands.find((arg) => arg.startsWith('$'))
  return variable ? `${name} ${truncate(variable, 80)}` : name
}
