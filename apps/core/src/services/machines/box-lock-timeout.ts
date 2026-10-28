/** box-provision.sh timed out before entering its per-box mutation lock. */
export const BOX_LOCK_TIMEOUT_EXIT_CODE = 73

/** Transient contention, not a failed provisioning phase. Keep the holder diagnostic. */
export class BoxLockTimeoutError extends Error {
  constructor(
    readonly sandboxId: string,
    readonly machineName: string,
    readonly diagnostics: string
  ) {
    super(
      `box provisioning for ${sandboxId} on machine ${machineName} timed out waiting for its lock: ${diagnostics.trim()}`
    )
    this.name = 'BoxLockTimeoutError'
  }
}
