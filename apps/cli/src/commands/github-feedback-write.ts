import { basename } from 'node:path'

/**
 * Whether a command run with the squad's GitHub credential could post an issue or pull request comment,
 * a review, or a review comment. Core records a write window for such a command, so it can tell Ficus's
 * reviews from the connected account owner's (GitHub attributes reviews to no app). Anything this does
 * not recognise counts as a possible write: a missed window would deliver Ficus's own review back to it.
 */
export function githubCommandMayWriteFeedback(command: readonly string[]): boolean {
  const [binary, ...args] = command
  if (!binary || basename(binary) !== 'gh') return true
  const [group, sub] = args
  if (group === undefined || ['--version', '-v', '--help', '-h'].includes(group)) return false
  if (READ_ONLY_GROUPS.has(group)) return false
  if (group === 'pr' || group === 'issue') {
    if (sub === undefined || ['--help', '-h'].includes(sub)) return false
    // close/reopen post a comment only with --comment/-c.
    if (sub === 'close' || sub === 'reopen')
      return args.some((arg) => /^(-c|--comment)(=|$)/.test(arg) || /^-c./.test(arg))
    return !(group === 'pr' ? PR_SAFE : ISSUE_SAFE).has(sub)
  }
  if (group === 'api') return apiMayWrite(args.slice(1))
  return true
}

/** gh command groups that cannot create comments or reviews. */
const READ_ONLY_GROUPS = new Set([
  'auth',
  'browse',
  'cache',
  'codespace',
  'completion',
  'config',
  'gist',
  'gpg-key',
  'help',
  'label',
  'org',
  'project',
  'release',
  'repo',
  'ruleset',
  'run',
  'search',
  'secret',
  'ssh-key',
  'status',
  'variable',
  'version',
  'workflow',
  'attestation',
])
const PR_SAFE = new Set([
  'view',
  'list',
  'checks',
  'diff',
  'status',
  'checkout',
  'create',
  'merge',
  'ready',
  'edit',
  'update-branch',
  'lock',
  'unlock',
  'revert',
])
const ISSUE_SAFE = new Set([
  'view',
  'list',
  'status',
  'create',
  'edit',
  'develop',
  'pin',
  'unpin',
  'lock',
  'unlock',
  'transfer',
  'delete',
])

/** `gh api` flags that take a value, so the next argument is not the endpoint. */
const API_VALUE_FLAGS = new Set([
  '-X',
  '--method',
  '-f',
  '-F',
  '--field',
  '--raw-field',
  '-H',
  '--header',
  '--input',
  '-q',
  '--jq',
  '-t',
  '--template',
  '--hostname',
  '-p',
  '--preview',
  '--cache',
])

/**
 * `gh api` writes when its method is not GET. Without `--method`, it sends POST as soon as any field or
 * input is given. GraphQL is always POST and writes only through a mutation; a query read from a file or
 * from `--input` cannot be checked, so it counts as a possible write.
 */
function apiMayWrite(args: readonly string[]): boolean {
  let endpoint: string | undefined
  let method: string | undefined
  const fields: string[] = []
  let input = false
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!
    const [flag, inline] = arg.startsWith('--') ? splitLong(arg) : splitShort(arg)
    if (!flag) {
      endpoint ??= arg
      continue
    }
    if (!API_VALUE_FLAGS.has(flag)) continue
    const value = inline ?? args[++index] ?? ''
    if (flag === '-X' || flag === '--method') method = value.toUpperCase()
    else if (['-f', '-F', '--field', '--raw-field'].includes(flag)) fields.push(value)
    else if (flag === '--input') input = true
  }
  if (endpoint === 'graphql') return input || fields.some((field) => /mutation/i.test(field) || /^[^=]*=@/.test(field))
  return (method ?? (fields.length || input ? 'POST' : 'GET')) !== 'GET'
}

function splitLong(arg: string): [string, string | undefined] {
  const equals = arg.indexOf('=')
  return equals === -1 ? [arg, undefined] : [arg.slice(0, equals), arg.slice(equals + 1)]
}

/** `-Xvalue` and `-X value` for short flags; anything not starting with `-` (or a bare `-`) is positional. */
function splitShort(arg: string): [string | undefined, string | undefined] {
  if (!arg.startsWith('-') || arg === '-') return [undefined, undefined]
  return [arg.slice(0, 2), arg.length > 2 ? arg.slice(2).replace(/^=/, '') : undefined]
}
