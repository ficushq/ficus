/** Operator-only breadcrumbs: FIXED stage labels (never values, paths, names or secrets) that the
 * root control worker appends to its root-only failure trail when a request is refused. */
const trail: string[] = []
export function noteStage(label: string): void {
  if (/^[a-z][a-z_-]{1,40}$/.test(label)) trail.push(label)
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
