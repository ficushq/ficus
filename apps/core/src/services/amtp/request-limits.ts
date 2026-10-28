/** Count-only preflight before the upstream envelope parser; retain its malformed-input contract. */
export function envelopeAttachmentsWithinLimit(raw: string): boolean {
  try {
    const value = JSON.parse(raw)
    return !Array.isArray(value?.attachments) || value.attachments.length <= 100
  } catch {
    return true
  }
}

/** Bound recursive card JSON before the upstream recursive Zod schema sees it. */
export function cardStructureWithinLimit(input: unknown): boolean {
  const stack: Array<{ value: unknown; depth: number }> = [{ value: input, depth: 0 }]
  let nodes = 0
  while (stack.length) {
    const { value, depth } = stack.pop()!
    if (++nodes > 10000 || depth > 32) return false
    if (Array.isArray(value)) {
      if (value.length > 1000) return false
      for (const child of value) stack.push({ value: child, depth: depth + 1 })
    } else if (value && typeof value === 'object') {
      let keys = 0
      for (const key in value) {
        if (!Object.hasOwn(value, key)) continue
        if (++keys > 256) return false
        stack.push({ value: (value as Record<string, unknown>)[key], depth: depth + 1 })
      }
    }
  }
  return true
}
