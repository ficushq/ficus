import type { Machine, MachineBox } from './queries'
import { boxUnitControl, boxUnixUser } from './box-paths'
import type { SshResult, SshRunner } from './ssh'

/**
 * Operator control of one box on its machine host, run on the tenant Core VM
 * by the bundled `dist/box-control.js` entrypoint. It reuses Core's own box
 * naming, unit layout, machine key and SSH runner, so it works on an artifact
 * install where Core's source tree is not present.
 */
export const BOX_CONTROL_ACTIONS = ['status', 'stop', 'start', 'restart', 'processes', 'kill'] as const
export type BoxControlAction = (typeof BOX_CONTROL_ACTIONS)[number]

export const BOX_CONTROL_SIGNALS = ['TERM', 'INT', 'KILL'] as const
export type BoxControlSignal = (typeof BOX_CONTROL_SIGNALS)[number]

export type BoxControlRequest =
  | { sandboxId: string; action: Exclude<BoxControlAction, 'kill'> }
  | { sandboxId: string; action: 'kill'; pid: number; signal: BoxControlSignal }

/**
 * Read a request from the environment. Values arrive through env vars (never
 * interpolated into a shell by the caller) and are validated before any is
 * placed in a remote command.
 */
export function parseBoxControlRequest(env: Record<string, string | undefined>): BoxControlRequest {
  const sandboxId = env.FICUS_BC_SANDBOX_ID ?? ''
  const action = env.FICUS_BC_ACTION || 'status'
  if (!/^[A-Za-z0-9._:-]+$/.test(sandboxId)) {
    throw new Error(`invalid sandboxId '${sandboxId}' — expected [A-Za-z0-9._:-]+`)
  }
  if (!BOX_CONTROL_ACTIONS.includes(action as BoxControlAction)) {
    throw new Error(`invalid action '${action}' — one of: ${BOX_CONTROL_ACTIONS.join(', ')}`)
  }
  if (action !== 'kill') return { sandboxId, action: action as Exclude<BoxControlAction, 'kill'> }
  const pid = Number(env.FICUS_BC_PID)
  if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error(`invalid pid '${env.FICUS_BC_PID ?? ''}'`)
  const signal = (env.FICUS_BC_SIGNAL || 'TERM').toUpperCase()
  if (!BOX_CONTROL_SIGNALS.includes(signal as BoxControlSignal)) {
    throw new Error(`invalid signal '${signal}' — one of: ${BOX_CONTROL_SIGNALS.join(', ')}`)
  }
  return { sandboxId, action: 'kill', pid, signal: signal as BoxControlSignal }
}

/** The command run on the machine host for a request. */
export function buildBoxControlCommand(request: BoxControlRequest): string {
  const unixUser = boxUnixUser(request.sandboxId)
  if (request.action === 'processes') return boxProcessesCommand(unixUser)
  if (request.action === 'kill') return boxKillCommand(unixUser, request.pid, request.signal)
  const ctl = boxUnitControl({ sandboxId: request.sandboxId, unixUser })
  // A box is several units under socket activation. `stop` must take them all
  // down, socket first, or the next connection simply re-activates the server.
  const target = request.action === 'stop' ? ctl.allUnits : ctl.unit
  return `${ctl.systemctl} ${request.action} ${target}`
}

/**
 * Read-only view of what a box is running. CPU comes from top's second sample,
 * which is current usage; ps's %CPU is a lifetime average and makes an idle
 * long-running process look busy. Containers come from the box's rootless
 * Docker daemon, bounded so an overloaded daemon cannot hang the command.
 */
export function boxProcessesCommand(unixUser: string): string {
  const user = `'${unixUser}'`
  return [
    `U=${user}`,
    'uid=$(id -u "$U") || exit 1',
    'echo "== machine"',
    'echo "cpus $(nproc)  load $(cut -d" " -f1-3 /proc/loadavg)"',
    'free -m | sed -n 2p',
    'echo "== processes (current CPU)"',
    'top -b -n 2 -d 2 -c -w 220 -u "$U" | awk \'/^top -/{n++} n==2 && /^ *[0-9]+ /\' | head -40',
    'echo "== containers"',
    'sudo -u "$U" env XDG_RUNTIME_DIR=/run/user/$uid DOCKER_HOST=unix:///run/user/$uid/docker.sock ' +
      "timeout 20 docker ps -a --format '{{.ID}}  {{.Names}}  {{.Status}}  {{.Image}}' 2>/dev/null " +
      '|| echo "(no rootless docker, or it did not answer within 20s)"',
  ].join('\n')
}

/**
 * Signal one process, only if the box's own user owns it: this can never touch
 * another box, the machine's services, or the box's user manager.
 */
export function boxKillCommand(unixUser: string, pid: number, signal: BoxControlSignal): string {
  return [
    `U='${unixUser}'`,
    `PID=${pid}`,
    'owner=$(ps -o user= -p "$PID" 2>/dev/null | tr -d " ")',
    'if [ "$owner" != "$U" ]; then echo "refused: pid $PID is not owned by $U (owner: ${owner:-no such process})" >&2; exit 3; fi',
    'comm=$(ps -o comm= -p "$PID")',
    'case "$comm" in systemd|"(sd-pam)") echo "refused: pid $PID is the box user manager ($comm)" >&2; exit 3;; esac',
    'ps -o pid,etime,args -p "$PID" | cut -c1-200',
    `sudo kill -${signal} "$PID" && echo "sent SIG${signal} to $PID"`,
  ].join('\n')
}

export interface BoxControlDeps {
  getMachineBox(sandboxId: string): Promise<MachineBox | null>
  getMachine(id: string): Promise<Machine | null>
  runner: SshRunner
}

/** Resolve the box's machine and run the request there with Core's SSH runner. */
export async function runBoxControl(request: BoxControlRequest, deps: BoxControlDeps): Promise<SshResult> {
  const box = await deps.getMachineBox(request.sandboxId)
  if (!box) throw new Error(`box not registered on any machine: ${request.sandboxId}`)
  const machine = await deps.getMachine(box.machineId)
  if (!machine) throw new Error(`machine not found: ${box.machineId}`)
  // `processes` samples CPU for a few seconds; allow for a slow, loaded host.
  return deps.runner.run(machine, buildBoxControlCommand(request), { timeoutMs: 120_000 })
}
