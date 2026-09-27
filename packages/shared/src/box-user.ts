/**
 * Header names that carry a box's unix user to the machine's browser service
 * (under `scripts/machine/browser/`), alongside the box's bearer.
 *
 * K3: senders set every name. Running boxes and the shared machine image
 * outlive a Core upgrade, and a rollback pairs an older Core with a newer
 * image, so the pre-Ficus name is sent too until every host has migrated.
 * The browser service accepts either name.
 */
export const BOX_USER_HEADERS = ['x-ficus-box-user', 'x-tau-box-user'] as const // K3

/** The box-user headers for one request: every name in {@link BOX_USER_HEADERS}, with the same value. */
export function boxUserHeaders(boxUser: string): Record<string, string> {
  return Object.fromEntries(BOX_USER_HEADERS.map((name) => [name, boxUser]))
}
