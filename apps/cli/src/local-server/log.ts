/**
 * Narration for the local installer and `ficus server` / `ficus update`.
 *
 * Progress lines are not errors, so they go to STDOUT (some terminals paint
 * everything on stderr red) and get a light-blue tint on a colour-capable
 * TTY: step headers bold, plan details plain, warnings yellow. Real errors
 * still go through outputError on stderr.
 */
const LIGHT_BLUE = '\x1b[94m'
const YELLOW = '\x1b[33m'
const BOLD = '\x1b[1m'
const RESET = '\x1b[0m'

export function colorEnabled(
  env: Record<string, string | undefined> = process.env,
  isTTY = process.stdout.isTTY
): boolean {
  return Boolean(isTTY) && !env.NO_COLOR && env.TERM !== 'dumb'
}

/** Applies the narration style to one line; identity when colour is off. */
export function styleNarration(line: string, color = colorEnabled()): string {
  if (!color || line === '') return line
  if (line.startsWith('  warning:')) return `${YELLOW}${line}${RESET}`
  if (line.startsWith('▸ ') || line.startsWith('Preflight (') || line === 'Plan:' || line.startsWith('Dry run')) {
    return `${BOLD}${LIGHT_BLUE}${line}${RESET}`
  }
  if (line.startsWith('    ')) return `${LIGHT_BLUE}${line}${RESET}`
  return line
}

export function narrate(line: string): void {
  console.log(styleNarration(line))
}
