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
 *   retired per-agent credential files pending cleanup), shell history and
 *   config, `.ssh`, the confined writer's own `.ficus-upload-*` temp files,
 *   and any future platform file that follows the dot-dir convention.
 * - `identity.pem` at the private root, where the vm runtime pushes the
 *   agent's federation identity key.
 * - The settings directory at the private root, named by the same rule as the
 *   squad workspace's (`isWorkspaceSettingsDirName`: case and trailing dots
 *   or spaces ignored). The dot-prefix rule already covers it; this keeps it
 *   hidden and unwritable even if that rule is ever relaxed.
 *
 * No other check is needed for symlinks or `..`: the confined walk rejects
 * `..` outright and never follows a symlink, so a link the agent plants that
 * points into the settings directory is refused rather than resolved.
 *
 * `chat-attachments/` holds files materialized from chat uploads. Its contents
 * are checked against stored blobs, so it is readable but never writable here.
 *
 * A terminal in the agent's box (which also needs `terminal:access`) is not
 * limited by this policy: a shell sees whatever the agent sees.
 */

import { isWorkspaceSettingsDirName } from '../workspace/dot-dir'

const HIDDEN_ROOT_NAMES = new Set(['identity.pem'])
const READ_ONLY_ROOT_DIRS = new Set(['chat-attachments'])

/** Whether a path (as components below the private root) is hidden from the browser. */
export function isHiddenPrivatePath(parts: readonly string[]): boolean {
  if (parts.some((part) => part.startsWith('.'))) return true
  if (parts.length > 0 && isWorkspaceSettingsDirName(parts[0]!)) return true
  // Case-insensitive: a host-runtime private dir may sit on a case-insensitive filesystem (macOS).
  return parts.length > 0 && HIDDEN_ROOT_NAMES.has(parts[0]!.toLowerCase())
}

/** Whether the browser may create or replace a file at this path. */
export function isWritablePrivatePath(parts: readonly string[]): boolean {
  if (parts.length === 0 || isHiddenPrivatePath(parts)) return false
  return !READ_ONLY_ROOT_DIRS.has(parts[0]!.toLowerCase())
}
