/**
 * Header names that carry a box's unix user to the machine's browser service
 * (under `scripts/machine/browser/`), alongside the box's bearer.
 */
export const BOX_USER_HEADERS = ['x-ficus-box-user'] as const

/** The box-user headers for one request: every name in {@link BOX_USER_HEADERS}, with the same value. */
export function boxUserHeaders(boxUser: string): Record<string, string> {
  return Object.fromEntries(BOX_USER_HEADERS.map((name) => [name, boxUser]))
}
