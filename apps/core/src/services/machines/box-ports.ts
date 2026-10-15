/**
 * The loopback ports Ficus owns on a VM machine.
 *
 * Every box's `.socket` unit listens on `127.0.0.1:<port>` with a port from
 * the box range, and Core's reverse tunnel listens on the callback port. All of
 * them share the machine's single loopback with every box user's own processes
 * and with the kernel's ephemeral (auto-assigned) ports.
 *
 * Linux's default ephemeral range is 32768-60999, which contains the whole box
 * range. Any outgoing loopback connection (Core's sshd forwards, box → callback
 * traffic) could take a box port as its local port, and the box's socket then
 * fails to bind. So bootstrap.sh and box-provision.sh add exactly this range to
 * `net.ipv4.ip_local_reserved_ports` (see `ensure_box_port_reservation` in
 * both scripts). The shell copies spell out the same numbers, and
 * box-ports.test.ts keeps all three in agreement.
 *
 * Why 59999 as the upper bound: the old allocator handed out MAX(port)+1 and
 * never reused a port, so long-lived machines already carry ports well above
 * 50100 (51276 was seen live on 2026-10-15). 9,900 ports keep every port
 * allocated so far inside the reservation, with room to spare. Most of the
 * ephemeral range is still free: 32768-50079 and 60000-60999, about 18,300
 * ports.
 */

/** Core's reverse-tunnel callback port on every machine (`-R 50080:...`). */
export const MACHINE_CALLBACK_PORT = 50080

/** Lowest port a box may be allocated on a machine. */
export const FIRST_BOX_PORT = 50100

/** Highest port a box may be allocated on a machine (inclusive). */
export const LAST_BOX_PORT = 59999

/**
 * The value bootstrap.sh / box-provision.sh merge into
 * `net.ipv4.ip_local_reserved_ports`.
 */
export const BOX_RESERVED_PORTS_SYSCTL = `${MACHINE_CALLBACK_PORT},${FIRST_BOX_PORT}-${LAST_BOX_PORT}`

/** True for a port inside the box allocation range. */
export function isBoxPort(port: number): boolean {
  return Number.isInteger(port) && port >= FIRST_BOX_PORT && port <= LAST_BOX_PORT
}

/**
 * True for any port Ficus reserves on a machine's loopback: the box range plus
 * the callback port. Nothing else on a shared VM machine may claim one.
 */
export function isFicusReservedMachinePort(port: number): boolean {
  return port === MACHINE_CALLBACK_PORT || isBoxPort(port)
}

/** Thrown when every port in the box range is already allocated on a machine. */
export class BoxPortRangeExhaustedError extends Error {
  constructor(readonly machineId: string) {
    super(
      `machine ${machineId} has no free box port: every port in ${FIRST_BOX_PORT}-${LAST_BOX_PORT} is allocated. ` +
        `Remove unused boxes or place this box on another machine.`
    )
    this.name = 'BoxPortRangeExhaustedError'
  }
}
