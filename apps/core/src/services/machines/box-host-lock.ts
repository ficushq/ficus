/** Remote lock acquisition must finish well inside the SSH/stream budget.
 * Keep at least three quarters for connection setup, work and cleanup. */
export function boxLockWaitSeconds(timeoutMs: number): number {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('Invalid box SSH timeout')
  return Math.min(180, Math.floor(timeoutMs / 4_000))
}

export const DEFAULT_BOX_SSH_TIMEOUT_MS = 30_000

export function boxProvisionLockArgs(timeoutMs: number): string {
  // argv survives sudo env_reset, unlike FICUS_BOX_LOCK_WAIT_SECONDS.
  return `--lock-wait-seconds ${boxLockWaitSeconds(timeoutMs)}`
}

/** Same stable inode and inherited FD as box-provision.sh. Run INSIDE root's
 * shell, holding through every mutation/readback; never unlink the inode.
 * FICUS_HOST_ROOT is the same owned synthetic-host seam as the provisioner. */
export function boxHostLockScript(unixUser: string, timeoutMs: number): string {
  if (!/^[a-z_][a-z0-9_-]{0,30}$/.test(unixUser)) throw new Error('Invalid box unix user')
  const wait = boxLockWaitSeconds(timeoutMs)
  return `box_lock_dir="\${FICUS_HOST_ROOT:-}/run/ficus-box-locks"
[ ! -L "$box_lock_dir" ] || exit 2
install -d -m 0755 "$box_lock_dir"
box_lock_path="$box_lock_dir/ficus-box-${unixUser}.lock"
[ ! -L "$box_lock_path" ] || exit 2
(umask 022; touch "$box_lock_path")
exec 200<>"$box_lock_path"
if ! flock -x -w ${wait} 200; then
  box_lock_holder=$(cat "$box_lock_path" 2>/dev/null)
  echo "FICUS_BOX_LOCK_TIMEOUT box=${unixUser} holder_pid=\${box_lock_holder:-unknown} wait_seconds=${wait} lock=$box_lock_path" >&2
  exit 73
fi
: >"$box_lock_path"
printf '%s\\n' "$$" >&200
`
}

export function withBoxHostLock(unixUser: string, command: string, timeoutMs = DEFAULT_BOX_SSH_TIMEOUT_MS): string {
  const script = `set -e\n${boxHostLockScript(unixUser, timeoutMs)}${command}`
  return `sudo -n bash -c '${script.replace(/'/g, `'\\''`)}'`
}
