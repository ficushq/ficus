/** Cheap request-boundary guards for handwritten validators, before element/DB work. */
export function assertArrayLimit(value: unknown, maximum: number, label: string): void {
  if (Array.isArray(value) && value.length > maximum) throw new Error(`Use at most ${maximum} ${label}`)
}
export function assertRecordLimit(value: unknown, maximum: number, label: string): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return
  let count = 0
  for (const key in value)
    if (Object.hasOwn(value, key) && ++count > maximum) throw new Error(`Use at most ${maximum} ${label}`)
}
