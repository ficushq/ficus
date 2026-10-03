import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { boxUnitControl, boxHomeForUser } from './box-paths'
import type { Machine, MachineBox } from './queries'
import type { SshRunner } from './ssh'
import {
  ReprovisionError,
  parseReprovisionEnv,
  validateRuntime,
  type RuntimeState,
  type ReprovisionJournal,
} from './box-reprovision'

function q(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}
function remote(script: string): string {
  return `sudo -n bash -c ${q(`set -eu\n${script}`)}`
}
export function readReprovisionEnvCommand(box: MachineBox): string {
  const home = boxHomeForUser(box.unixUser)
  return remote(`home=${q(home)}
[ ! -L "$home" ] && [ "$(realpath -e "$home")" = "$home" ]
[ ! -L "$home/.ficus" ]
file=${q(`${home}/.ficus/server.env`)}
[ -f "$file" ] && [ ! -L "$file" ]
[ "$(realpath -e "$file")" = "$home/.ficus/server.env" ]
cat -- "$file"`)
}

function runtimePreamble(box: MachineBox): string {
  const ctl = boxUnitControl(box)
  const home = boxHomeForUser(box.unixUser)
  return `u=${q(box.unixUser)}
home=${q(home)}
uid=$(id -u "$u")
[ "$(getent passwd "$u" | cut -d: -f6)" = "$home" ]
mode=${q(ctl.mode)}
base=${q(ctl.mode === 'system' ? '/etc/systemd/system' : `${home}/.config/systemd/user`)}
new=${q(ctl.unit)}
[ -f "$base/$new" ] && [ ! -L "$base/$new" ]
unit=$new
stem=\${unit%.service}
socket=$stem.socket
proxy=$stem-proxy.service
userctl() { systemctl --machine="$u@.host" --user "$@"; }
boxctl() { if [ "$mode" = system ]; then systemctl "$@"; else userctl "$@"; fi; }
active() {
  local value controller=$1 target=$2
  value=$("$controller" show --property=ActiveState --value "$target")
  case "$value" in active) printf true;; inactive) printf false;; *) exit 3;; esac
}
manager=$(active systemctl "user@$uid.service")
useractive() { if [ "$manager" = true ]; then active userctl "$1"; else printf false; fi; }
boxactive() { if [ "$mode" = system ]; then active systemctl "$1"; else useractive "$1"; fi; }
userenabled() {
  local file
  for file in "$home/.config/systemd/user/"*.wants/"$1"; do
    if [ -L "$file" ]; then printf true; return; fi
  done
  printf false
}
enabled() {
  local value
  if [ "$mode" = user ]; then userenabled "$1"; return; fi
  value=$(systemctl is-enabled "$1" 2>/dev/null) || :
  case "$value" in enabled|enabled-runtime) printf true;; disabled|static|indirect|not-found|linked|linked-runtime) printf false;; *) exit 3;; esac
}`
}
export function captureRuntimeCommand(box: MachineBox): string {
  return remote(`${runtimePreamble(box)}
server=$(boxactive "$unit")
sock=$(boxactive "$socket")
prox=$(boxactive "$proxy")
docker=$(useractive docker.service)
linger=false; [ ! -e "/var/lib/systemd/linger/$u" ] || linger=true
server_enabled=$(enabled "$unit")
socket_enabled=$(enabled "$socket")
docker_enabled=$(userenabled docker.service)
printf '{"server":%s,"socket":%s,"proxy":%s,"docker":%s,"manager":%s,"linger":%s,"serverEnabled":%s,"socketEnabled":%s,"dockerEnabled":%s}\\n' "$server" "$sock" "$prox" "$docker" "$manager" "$linger" "$server_enabled" "$socket_enabled" "$docker_enabled"`)
}
export function restoreRuntimeCommand(box: MachineBox, state: RuntimeState): string {
  validateRuntime(state)
  return remote(`${runtimePreamble(box)}
# Provision may have started sockets, the user manager and rootless Docker.
# Stop only this registered box's chain before restoring its recorded intent.
if [ "$mode" = system ] || [ "$manager" = true ]; then
  boxctl stop "$socket" "$proxy" "$unit"
fi
if [ "$manager" = true ] && [ -f "$home/.config/systemd/user/docker.service" ]; then userctl stop docker.service; fi
if [ "$mode" = user ] || [ ${state.manager} = true ] || [ ${state.docker} = true ]; then
  systemctl start "user@$uid.service"
  manager=true
fi
restore_enabled() { if [ "$2" = true ]; then boxctl enable "$1"; else boxctl disable "$1"; fi; }
restore_enabled "$unit" ${state.serverEnabled}
restore_enabled "$socket" ${state.socketEnabled}
if [ -f "$home/.config/systemd/user/docker.service" ]; then
  if [ "$manager" != true ]; then systemctl start "user@$uid.service"; manager=true; fi
  if [ ${state.dockerEnabled} = true ]; then userctl enable docker.service; else userctl disable docker.service; fi
  if [ ${state.docker} = true ]; then userctl reset-failed docker.service; userctl start docker.service; fi
fi
if [ ${state.socket} = true ]; then boxctl reset-failed "$socket"; boxctl start "$socket"; fi
if [ ${state.server} = true ]; then boxctl reset-failed "$unit"; boxctl start "$unit"; fi
if [ ${state.proxy} = true ]; then boxctl reset-failed "$proxy"; boxctl start "$proxy"; fi
if [ ${state.linger} = true ]; then loginctl enable-linger "$u"; else loginctl disable-linger "$u"; fi
if [ ${state.manager} = false ]; then systemctl stop "user@$uid.service"; fi`)
}
export function verifyInstalledCommand(box: MachineBox): string {
  const ctl = boxUnitControl(box)
  const home = boxHomeForUser(box.unixUser)
  const base = ctl.mode === 'system' ? '/etc/systemd/system' : `${home}/.config/systemd/user`
  return remote(`u=${q(box.unixUser)}
home=${q(home)}
base=${q(base)}
uid=$(id -u "$u")
owner=${ctl.mode === 'system' ? '0' : '$uid'}
[ ! -L "$home/.ficus" ] && [ -d "$home/.ficus" ]
[ ! -L "$home/.ficus/server.env" ] && [ -f "$home/.ficus/server.env" ]
[ "$(stat -c '%u:%a' "$home/.ficus/server.env")" = "$uid:600" ]
for name in ${[ctl.unit, ctl.socket, ctl.proxy].map(q).join(' ')}; do
  [ -f "$base/$name" ] && [ ! -L "$base/$name" ]
  [ "$(stat -c '%u:%a' "$base/$name")" = "$owner:644" ]
  if grep -q '^Alias=' "$base/$name"; then exit 3; fi
done
grep -Fq 'ExecStart=/opt/ficus/bin/bun /opt/ficus/server/server.js' "$base/${ctl.unit}"
grep -Fq '/.ficus/server.env' "$base/${ctl.unit}"
token=${q(`/opt/ficus/browser-tokens/${box.unixUser}.token`)}
gid=$(getent group ficus-browser | cut -d: -f3)
[ -n "$gid" ] && [ -f "$token" ] && [ ! -L "$token" ]
[ "$(stat -c '%u:%g:%a' "$token")" = "0:$gid:640" ]
expected=$(cat)
[ "$(cat "$token")" = "$expected" ]
runuser -u ficus-browser -- test -r "$token"`)
}

export function createRemoteReprovisionRuntime(runner: SshRunner) {
  async function run(machine: Machine, command: string, stdin?: string) {
    const result = await runner.run(machine, command, { timeoutMs: 120_000, stdin })
    if (result.exitCode !== 0) throw new ReprovisionError('remote-operation-failed')
    return result.stdout
  }
  async function captureRuntime(machine: Machine, box: MachineBox): Promise<RuntimeState> {
    let state: RuntimeState
    try {
      state = JSON.parse(await run(machine, captureRuntimeCommand(box)))
    } catch {
      throw new ReprovisionError('runtime-probe-failed')
    }
    validateRuntime(state)
    return state
  }
  return {
    readEnv: (machine: Machine, box: MachineBox) => run(machine, readReprovisionEnvCommand(box)),
    captureRuntime,
    verifyInstalled: async (machine: Machine, box: MachineBox) => {
      await run(machine, verifyInstalledCommand(box), createHash('sha256').update(box.authToken!).digest('hex'))
      const env = parseReprovisionEnv(await run(machine, readReprovisionEnvCommand(box)), box)
      const home = boxHomeForUser(box.unixUser)
      if (
        env.FICUS_BOX_HOME !== home ||
        env.FICUS_DEVBOX_DIR !== `${home}/.ficus/devbox` ||
        env.FICUS_TOOLCHAIN_DIR !== `${home}/.ficus/toolchain`
      )
        throw new ReprovisionError('installed-env-path-mismatch')
    },
    restoreRuntime: async (machine: Machine, box: MachineBox, state: RuntimeState) => {
      await run(machine, restoreRuntimeCommand(box, state))
      const actual = await captureRuntime(machine, box)
      if (Object.keys(state).some((k) => actual[k as keyof RuntimeState] !== state[k as keyof RuntimeState]))
        throw new ReprovisionError('runtime-restoration-mismatch')
    },
  }
}

/** Root-owned local journal: atomic replacement plus file and parent-directory fsync. */
export function createReprovisionJournal(root = '/var/backups/ficus-box-reprovision') {
  const path = (id: string) => join(root, `${createHash('sha256').update(id).digest('hex')}.json`)
  async function checkRoot(create: boolean) {
    if (create) await mkdir(root, { mode: 0o700, recursive: true })
    const stat = await lstat(root)
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid!() || (stat.mode & 0o077) !== 0)
      throw new ReprovisionError('unsafe-journal-directory')
  }
  return {
    async read(id: string): Promise<ReprovisionJournal | null> {
      try {
        await checkRoot(false)
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw e
      }
      try {
        const info = await lstat(path(id))
        if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid!() || (info.mode & 0o077) !== 0)
          throw new ReprovisionError('unsafe-journal-file')
        return JSON.parse(await readFile(path(id), 'utf8'))
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw e
      }
    },
    async write(id: string, value: ReprovisionJournal): Promise<void> {
      await checkRoot(true)
      const temp = `${path(id)}.${randomUUID()}.tmp`
      const file = await open(temp, 'wx', 0o600)
      try {
        await file.writeFile(`${JSON.stringify(value)}\n`)
        await file.sync()
      } finally {
        await file.close()
      }
      await rename(temp, path(id))
      const directory = await open(root, 'r')
      try {
        await directory.sync()
      } finally {
        await directory.close()
      }
    },
  }
}

export const REPROVISION_GUARD_NAME = '90-ficus-box-reprovision.conf'
export const REPROVISION_ALLOW_START = '/run/ficus-box-reprovision.allow-start'
export const REPROVISION_GUARD_CONTENT = `[Unit]\nConditionPathExists=${REPROVISION_ALLOW_START}\n`
export type LocalRun = (argv: string[]) => Promise<{ exitCode: number; stdout: string; stderr: string }>
export const runLocal: LocalRun = async (argv) => {
  const child = Bun.spawn(argv, { stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  return { stdout, stderr, exitCode }
}
export function validateMaintenanceEvidence(props: string, conditions: unknown, guardPath: string): void {
  const fields = Object.fromEntries(
    props
      .trim()
      .split('\n')
      .map((line) => {
        const at = line.indexOf('=')
        return [line.slice(0, at), line.slice(at + 1)]
      })
  )
  if (
    fields.LoadState !== 'loaded' ||
    fields.ActiveState !== 'inactive' ||
    !fields.DropInPaths?.split(' ').includes(guardPath)
  )
    throw new ReprovisionError('maintenance-guard-not-effective')
  // busctl JSON exposes the Conditions array directly in data.
  const data = (conditions as { data?: unknown[] })?.data
  const entries = Array.isArray(data) ? data : []
  if (
    !entries.some(
      (value: unknown) =>
        Array.isArray(value) &&
        value[0] === 'ConditionPathExists' &&
        value[1] === false &&
        value[2] === false &&
        value[3] === REPROVISION_ALLOW_START
    )
  )
    throw new ReprovisionError('maintenance-condition-not-effective')
}
export async function assertLocalReprovisionMaintenance(run: LocalRun = runLocal): Promise<void> {
  if (process.platform !== 'linux' || process.getuid?.() !== 0) throw new ReprovisionError('requires-linux-root')
  try {
    await lstat(REPROVISION_ALLOW_START)
    throw new ReprovisionError('maintenance-allow-file-exists')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
  }
  for (const role of ['api', 'worker']) {
    const name = `ficus-${role}.service`
    const guardPath = `/run/systemd/system/${name}.d/${REPROVISION_GUARD_NAME}`
    const info = await lstat(guardPath)
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.uid !== 0 ||
      (info.mode & 0o022) !== 0 ||
      (await readFile(guardPath, 'utf8')) !== REPROVISION_GUARD_CONTENT
    )
      throw new ReprovisionError('maintenance-guard-invalid')
    const props = await run(['systemctl', 'show', name, '--property=LoadState,ActiveState,DropInPaths'])
    const busPath = `/org/freedesktop/systemd1/unit/ficus_2d${role}_2eservice`
    const conditions = await run([
      'busctl',
      '--json=short',
      'get-property',
      'org.freedesktop.systemd1',
      busPath,
      'org.freedesktop.systemd1.Unit',
      'Conditions',
    ])
    if (props.exitCode || conditions.exitCode) throw new ReprovisionError('maintenance-probe-failed')
    validateMaintenanceEvidence(props.stdout, JSON.parse(conditions.stdout), guardPath)
  }
}

/** Probe the already-running server directly, so its TCP proxy remains idle. */
export function runningReprovisionProbeCommand(box: MachineBox): string {
  const ctl = boxUnitControl(box)
  const socket =
    ctl.mode === 'system'
      ? `sock=${q(`/run/${ctl.unit.slice(0, -'.service'.length)}/server.sock`)}`
      : `uid=$(id -u ${q(box.unixUser)})\nsock="/run/user/$uid/ficus-sandbox/server.sock"`
  return remote(`${socket}
curl -fsS --retry 15 --retry-connrefused --retry-delay 1 --retry-max-time 30 --max-time 3 --unix-socket "$sock" http://localhost/healthz >/dev/null
curl -fsS --max-time 10 --unix-socket "$sock" --config - http://localhost/watch >/dev/null`)
}
