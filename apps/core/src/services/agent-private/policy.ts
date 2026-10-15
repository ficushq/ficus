/**
 * Which parts of an agent's private area the browser may touch.
 *
 * Decision: platform-managed custody files are HIDDEN, not shown read-only.
 * They are left out of listings and every read, download or write of them is
 * refused as if they did not exist. Showing a private key read-only would
 * still put it on screen and in the browser cache, and nobody needs to edit
 * it by hand. Hidden:
 *
 * - Every dot-prefixed path component. That covers the platform settings dir
 *   `.ficus/` (where docker/host keep `identity.pem`, the toolchain state and
 *   any per-agent secrets file the platform writes), shell history and
 *   config, `.ssh`, the confined writer's own `.ficus-upload-*` temp files,
 *   and any future platform file that follows the dot-dir convention.
 * - `identity.pem` at the private root, where the vm runtime pushes the
 *   agent's federation identity key.
 *
 * `chat-attachments/` holds files materialized from chat uploads. Its contents
 * are checked against stored blobs, so it is readable but never writable here.
 *
 * A terminal in the agent's box (which also needs `terminal:access`) is not
 * limited by this policy: a shell sees whatever the agent sees.
 */

const HIDDEN_ROOT_NAMES = new Set(['identity.pem'])
const READ_ONLY_ROOT_DIRS = new Set(['chat-attachments'])

/** Whether a path (as components below the private root) is hidden from the browser. */
export function isHiddenPrivatePath(parts: readonly string[]): boolean {
  if (parts.some((part) => part.startsWith('.'))) return true
  return parts.length > 0 && HIDDEN_ROOT_NAMES.has(parts[0]!)
}

/** Whether the browser may create or replace a file at this path. */
export function isWritablePrivatePath(parts: readonly string[]): boolean {
  if (parts.length === 0 || isHiddenPrivatePath(parts)) return false
  return !READ_ONLY_ROOT_DIRS.has(parts[0]!)
}
