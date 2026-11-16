/**
 * A box could not be provisioned because its machine host is under memory
 * pressure: systemd could not finish reloading the box's limits in time.
 *
 * Under heavy pressure every process on the host stalls on memory, systemd
 * included, so the `daemon-reload` that installs a box's root-owned limits can
 * time out (incident 2026-11-16: memory PSI full avg10=95%). box-provision.sh
 * reports exactly that case, and only when the host's pressure confirms it,
 * with its own exit status. The memory floors, swap and systemd-oomd on the
 * host relieve the pressure (docs/wiki/machines/memory-model.md), so the
 * execution waits and retries (startup-retry.ts matches it by name) instead of
 * failing as a Docker containment failure.
 */

/** box-provision.sh's `HOST_MEMORY_PRESSURE_EXIT` (sysexits' EX_UNAVAILABLE). */
export const BOX_HOST_MEMORY_PRESSURE_EXIT_CODE = 69

export class BoxHostMemoryPressureError extends Error {
  constructor(
    readonly sandboxId: string,
    readonly machineName: string,
    /** The script's stderr, including the PSI reading. */
    readonly diagnostics: string
  ) {
    super(
      `box provisioning for ${sandboxId} on machine ${machineName} was delayed by host memory pressure ` +
        `(will retry): ${diagnostics.trim()}`
    )
    this.name = 'BoxHostMemoryPressureError'
  }

  /** The host's memory pressure as box-provision.sh read it, for the stream notice. */
  get summary(): string {
    const reading = /FICUS_HOST_MEMORY_PRESSURE\s+box=\S+\s+(some avg10=\S+ full avg10=\S+)/.exec(this.diagnostics)
    return reading ? `memory pressure ${reading[1]} on ${this.machineName}` : `memory pressure on ${this.machineName}`
  }
}
