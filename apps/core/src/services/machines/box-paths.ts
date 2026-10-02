/**
 * Deterministic vm-box naming + home-layout derivation, and the systemd-unit
 * control seam derived from the same sandboxId.
 *
 * Pure leaf module (crypto only, no db/network imports) so that BOTH
 * box-manager (provisioning) and services/sandbox/workspace-layout (agent
 * path resolution) can derive a box's unix user / HOME without importing each
 * other — a box's paths are fully derivable from its sandboxId alone, no live
 * box or db row required. {@link boxUnitControl} lives here for the same
 * reason: box-migrate and the platform's box-control ops script need the box's
 * unit commands without pulling in box-manager's db/ssh surface.
 */

import { createHash } from 'crypto'

/** The single source of truth for a box's unix user: `box_<first 12 hex of
 *  sha256(sandboxId)>`. Must match box-provision.sh's removal guard. */
export function boxUnixUser(sandboxId: string): string {
  const hash = createHash('sha256').update(sandboxId).digest('hex').slice(0, 12)
  return `box_${hash}`
}

/** A box user's HOME (Ubuntu `useradd --create-home` default). */
export function boxHomeForUser(unixUser: string): string {
  return `/home/${unixUser}`
}

/** A box's HOME derived straight from its sandboxId. */
export function boxHome(sandboxId: string): string {
  return boxHomeForUser(boxUnixUser(sandboxId))
}

/**
 * The dot dir in a box user's HOME that holds its `server.env`, `host.env`,
 * devbox, toolchain and skills. box-provision.sh moves a box's legacy one here
 * on its next provision and leaves the legacy name as a relative link to it.
 */
export const BOX_DOT_DIR = '.ficus'
/** Bridge (phase 5, U4): the box HOME dot dir before the rename. */
export const LEGACY_BOX_DOT_DIR = '.tau' // ficus-p5-bridge

/** A box's HOME dot dir (`<home>/.ficus`). */
export function boxDotDir(home: string): string {
  return `${home}/${BOX_DOT_DIR}`
}

/** The machine root every box runs from (box-provision.sh, the server bundle, bun). */
export const MACHINE_ROOT = '/opt/ficus'

/**
 * Bridge (phase 5, U4): the unit names a box provisioned before the rename runs
 * under. Its units keep them until box-provision.sh re-provisions it (and the
 * Ficus units it then installs carry them as `Alias=`), so every command Core
 * builds for a box can still reach a box that has not been re-provisioned yet.
 */
export const LEGACY_BOX_UNIT_PREFIX = 'tau-box' // ficus-p5-bridge
export const LEGACY_USER_UNIT_PREFIX = 'tau-sandbox-server' // ficus-p5-bridge

const BOX_UNIT_PREFIX = 'ficus-box'
const USER_UNIT_PREFIX = 'ficus-sandbox-server'

/**
 * WHICH systemd manager runs a box's sandbox-server.
 *
 * - `system` — one root-owned unit per box under /etc/systemd/system
 *   (`ficus-box-<user>.service`, `User=`/`Group=<user>`, its own
 *   `ficus-box-<user>.slice`). No linger, so the box costs no `systemd --user`
 *   manager + dbus pair.
 * - `user` — the historical layout: `ficus-sandbox-server.service` inside the box
 *   user's own lingering user manager. Required by rootless docker, whose
 *   daemon IS a user service on /run/user/<uid>/docker.sock.
 */
export type BoxUnitMode = 'system' | 'user'

/**
 * The sandboxId PREFIX decides the unit mode, exactly as it decides the role
 * (#1315: "the prefix is authoritative"). `agent_*` boxes are light — they
 * never run containers (`roleWantsDocker` is false) — so they get the system
 * unit; `squad_*` / `system_manager_*` boxes keep the user manager their
 * rootless dockerd requires.
 *
 * An unknown prefix keeps the USER layout rather than falling through to the
 * agent default: role-wise an unknown id counts as an agent, but moving a live
 * legacy box onto a different unit is a change with teeth, and box-provision.sh
 * derives the same conservative default from the same prefix.
 */
export function boxUnitMode(sandboxId: string): BoxUnitMode {
  return sandboxId.startsWith('agent_') ? 'system' : 'user'
}

/** One box's three units under one naming. */
export interface BoxUnitNames {
  /** The SERVER unit — what `restart` targets, and what may be `inactive` on a
   *  perfectly healthy socket-activated box. */
  unit: string
  /** The socket unit that owns the box's 127.0.0.1:<port>. Always-on. */
  socket: string
  /** The systemd-socket-proxyd unit the socket activates. */
  proxy: string
  /** socket, proxy and server, space-joined in the order a teardown must stop
   *  them — the socket FIRST, or it re-activates the proxy mid-stop. */
  allUnits: string
}

/** The unit + the command prefixes that drive it. See {@link boxUnitControl}. */
export interface BoxUnitControl extends BoxUnitNames {
  mode: BoxUnitMode
  /** Bridge (phase 5, U4): the same three units under the names a box
   *  provisioned before the rename still runs. */
  legacy: BoxUnitNames
  /** Full systemctl command prefix INCLUDING sudo: `${systemctl} restart ${unit}`. */
  systemctl: string
  /** Full journalctl command through `-u <unit>` (both names while the bridge
   *  lasts); callers append their own `-n <lines> --no-pager` and redirection. */
  journalctl: string
  /** The `is-active` probe of one unit in this box's manager, as one command. */
  isActiveCommandOf: (unit: string) => string
  /** The SERVER unit's `is-active` probe, as one complete command. */
  isActiveCommand: () => string
  /** The SOCKET unit's `is-active` probe. An active socket is the box's real
   *  liveness signal: it means the port is held and the chain can wake. */
  socketIsActiveCommand: () => string
  /**
   * Bridge (phase 5, U4): `fn` applied to the unit set this box actually has on
   * its host, as ONE remote shell command. The legacy names are used only when
   * the box's legacy server unit is loaded and its Ficus one is not (a box not
   * re-provisioned since the rename); otherwise the Ficus names. `fn`'s command
   * keeps its own exit status. Failed/empty LoadState readbacks fail closed
   * rather than selecting a possibly unrelated naming.
   */
  onHost: (fn: (names: BoxUnitNames) => string) => string
  /**
   * A probe for an OLDER layout of the box that {@link onHost}'s two unit sets
   * do not cover, or `undefined` when there is none. Only system-mode boxes have
   * one: an `agent_*` box not re-provisioned since S2 still runs its server in
   * its own user manager, which no system-mode probe would ever see — and
   * calling that box `exited` would condemn a perfectly live box. During the
   * bridge it probes both legacy shapes (the legacy system units and the legacy
   * user unit) and prints one live state, or nothing.
   */
  legacyIsActiveCommand?: () => string
}

function unitNames(prefix: string): BoxUnitNames {
  const unit = `${prefix}.service`
  const socket = `${prefix}.socket`
  const proxy = `${prefix}-proxy.service`
  return { unit, socket, proxy, allUnits: `${socket} ${proxy} ${unit}` }
}

/** The states a box's unit may report while it is alive. */
const LIVE_STATES = 'active|activating|reloading|listening|running'

/**
 * The ONE seam every systemctl/journalctl string this codebase builds for a box
 * goes through, so the manager and box-provision.sh can never disagree about
 * which unit exists (the script is also passed `--unit-mode` explicitly, derived
 * from {@link boxUnitMode}).
 *
 * The two modes reach their manager in the two shapes systemd offers for
 * another user's manager: `--machine=<user>@.host --user` for control verbs
 * (needs a running per-user manager, which linger guarantees) and a
 * `sudo -u <user> env XDG_RUNTIME_DIR=…` drop for the read-only probes.
 *
 * CONTRACT: the user-mode `journalctl` / `isActiveCommand()` strings (and the
 * system-mode legacy probe) reference a `$uid` REMOTE shell variable, which the
 * calling command must define first (`uid=$(id -u <user>)`) — as box-manager's
 * machine snapshot does.
 */
export function boxUnitControl(input: { sandboxId: string; unixUser: string }): BoxUnitControl {
  const { unixUser } = input
  const mode = boxUnitMode(input.sandboxId)
  const asBoxUser = `sudo -u ${shellQuoteBoxPath(unixUser)} env XDG_RUNTIME_DIR=/run/user/$uid`
  const legacyUserUnit = `${LEGACY_USER_UNIT_PREFIX}.service`
  const names = unitNames(mode === 'system' ? `${BOX_UNIT_PREFIX}-${unixUser}` : USER_UNIT_PREFIX)
  const legacy = unitNames(mode === 'system' ? `${LEGACY_BOX_UNIT_PREFIX}-${unixUser}` : LEGACY_USER_UNIT_PREFIX)
  const systemctl = mode === 'system' ? 'sudo systemctl' : `sudo systemctl --machine=${unixUser}@.host --user`
  const isActiveCommandOf =
    mode === 'system'
      ? (unit: string) => `sudo systemctl is-active ${unit}`
      : (unit: string) => `${asBoxUser} systemctl --user is-active ${unit}`
  const loadState = (unit: string) => `${systemctl} show -p LoadState --value ${unit}`
  return {
    mode,
    ...names,
    legacy,
    systemctl,
    journalctl:
      mode === 'system'
        ? `sudo journalctl -u ${names.unit} -u ${legacy.unit}`
        : `${asBoxUser} journalctl --user -u ${names.unit} -u ${legacy.unit}`,
    isActiveCommandOf,
    isActiveCommand: () => isActiveCommandOf(names.unit),
    socketIsActiveCommand: () => isActiveCommandOf(names.socket),
    onHost: (fn) =>
      `legacy_load=$(${loadState(legacy.unit)}) && current_load=$(${loadState(names.unit)}) && ` +
      `[ -n "$legacy_load" ] && [ -n "$current_load" ] && ` +
      `if [ "$legacy_load" = loaded ] && [ "$current_load" != loaded ]; then ${fn(legacy)}; else ${fn(names)}; fi`,
    legacyIsActiveCommand:
      mode === 'system'
        ? () =>
            `{ sudo systemctl is-active ${legacy.socket} ${legacy.unit}; ` +
            `${asBoxUser} systemctl --user is-active ${legacyUserUnit}; } 2>/dev/null | grep -m1 -xE '${LIVE_STATES}'`
        : // A user-mode box's pre-socket layout used the SAME service unit name,
          // which onHost's legacy set already covers.
          undefined,
  }
}

/** Single-quote a value for safe interpolation into a remote shell command
 *  (same shape as box-manager's local helper, kept here so this stays a leaf). */
function shellQuoteBoxPath(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}
