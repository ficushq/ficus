/** Operator-only breadcrumbs: FIXED stage labels (never values, paths, names or secrets) that the
 * root control worker appends to its root-only failure trail when a request is refused. */
const trail: string[] = []
export function noteStage(label: string): void {
  if (/^[a-z][a-z0-9_-]{1,40}$/.test(label)) trail.push(label)
  if (trail.length > 16) trail.shift()
}
export function drainStages(): string[] {
  return trail.splice(0)
}
/** Throw an allowlisted reply code, recording which internal check produced it. */
export function refuse(code: string, label: string): never {
  noteStage(label)
  throw new Error(code)
}
/** Fixed token for a caught error: its errno code only (e.g. `enoent`), never its message. */
export function errnoToken(error: unknown): string {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
  return /^E[A-Z]{1,15}$/.test(code) ? code.toLowerCase() : 'check'
}
