import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs'
import { dirname, isAbsolute, join } from 'path'
import { bunPtyLibrary, nativeLogPath, type NativeComponent } from './launchd'
import { instanceNames } from './instance'
import type { SupervisorAdapter, SupervisorContext, SupervisorProcess } from './supervisor'

const WORKER_FIRST: NativeComponent[] = ['worker', 'api']
const API_FIRST: NativeComponent[] = ['api', 'worker']

function escaped(value: string): string {
  if ([...value].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127))
    throw new Error('Supervisor definitions cannot contain control characters')
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%')
}
function quoted(value: string): string {
  return `"${escaped(value)}"`
}
function directivePath(value: string): string {
  return escaped(value).replaceAll(' ', '\\x20')
}
function marker(root: string): string {
  return `ficus-generated-root:${Buffer.from(root).toString('base64url')}`
}

/** `<process>.service`, with the process named in the era the instance runs under. */
export function systemdUserNames(
  context: Pick<SupervisorContext, 'home' | 'label' | 'identity' | 'xdgConfigHome'>,
  component: NativeComponent
) {
  const processName = instanceNames(context.label, context.identity)[component]
  const unit = `${processName}.service`
  const config = context.xdgConfigHome || join(context.home, '.config')
  if (!isAbsolute(config)) throw new Error(`Supervisor config path must be absolute: ${config}`)
  return {
    process: processName,
    unit,
    path: join(config, 'systemd', 'user', unit),
    log: nativeLogPath(context, component),
  }
}

export function systemdUnit(context: SupervisorContext, component: NativeComponent): string {
  const names = systemdUserNames(context, component)
  const script = component === 'api' ? 'apps/core/dist/index.js' : 'apps/core/dist/worker.js'
  const pty = bunPtyLibrary(context)
  for (const value of [context.root, context.bunPath, context.pathEnv, pty, names.path, names.log]) escaped(value)
  for (const path of [context.root, context.bunPath, pty, names.path, names.log]) {
    if (!isAbsolute(path)) throw new Error(`Supervisor path must be absolute: ${path}`)
  }
  return `# ${marker(context.root)}
[Unit]
Description=Ficus local ${component} (${escaped(instanceNames(context.label, context.identity).label)})
StartLimitIntervalSec=0

[Service]
Type=simple
WorkingDirectory=${directivePath(context.root)}
Environment="NODE_ENV=production"
Environment="PATH=${escaped(context.pathEnv)}"
Environment="BUN_PTY_LIB=${escaped(pty)}"
ExecStart=${quoted(context.bunPath)} "run" "${script}"
Restart=on-failure
RestartSec=5
KillMode=control-group
TimeoutStopSec=30
LimitNOFILE=65536
UMask=0077
StandardOutput=append:${quoted(names.log)}
StandardError=append:${quoted(names.log)}

[Install]
WantedBy=default.target
`
}

const RETIRED_OWNERSHIP_PREFIX = 'tau-generated-root:' // ficus-p5-bridge: recognize exact-root ownership until local definitions are rewritten
function assertOwned(path: string, root: string): void {
  if (!existsSync(path)) return
  const definition = readFileSync(path, 'utf8')
  const markers = [marker(root), RETIRED_OWNERSHIP_PREFIX + Buffer.from(root).toString('base64url')]
  if (!markers.some((value) => definition.split('\n').includes(`# ${value}`)))
    throw new Error(`Refusing to replace supervisor definition not owned by this checkout: ${path}`)
}

function prepareLogs(context: SupervisorContext): void {
  // The directory of the log files themselves, so the two can never disagree.
  const dir = dirname(nativeLogPath(context, 'api'))
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  chmodSync(dir, 0o700)
  for (const component of WORKER_FIRST) {
    const path = nativeLogPath(context, component)
    if (!existsSync(path)) writeFileSync(path, '', { mode: 0o600 })
    chmodSync(path, 0o600)
  }
}
async function command(context: SupervisorContext, args: string[], optional = false): Promise<string> {
  const result = await context.runner(args)
  if (!optional && result.code !== 0)
    throw new Error(`${args.join(' ')} failed (exit ${result.code})${result.stderr ? `: ${result.stderr.trim()}` : ''}`)
  return result.stdout
}
async function healthyManager(context: SupervisorContext): Promise<void> {
  await command(context, ['systemctl', '--user', 'show-environment'])
}

async function installDefinitions(context: SupervisorContext): Promise<void> {
  const defs = WORKER_FIRST.map((component) => ({ component, ...systemdUserNames(context, component) }))
  for (const d of defs) assertOwned(d.path, context.root)
  const pty = bunPtyLibrary(context)
  if (!existsSync(pty)) throw new Error(`bun-pty native library is missing: ${pty}; run bun install and retry`)
  mkdirSync(join(defs[0].path, '..'), { recursive: true })
  prepareLogs(context)
  // systemd-analyze derives the unit type from the filename, so staged files
  // keep the final `<unit>.service` name; a `.tmp` suffix is rejected outright.
  const staging = join(defs[0].path, '..', `.ficus-staging-${process.pid}`)
  const temps: string[] = []
  try {
    mkdirSync(staging, { recursive: true, mode: 0o700 })
    for (const d of defs) {
      const temp = join(staging, d.unit)
      writeFileSync(temp, systemdUnit(context, d.component), { mode: 0o600 })
      temps.push(temp)
    }
    if (context.which('systemd-analyze')) await command(context, ['systemd-analyze', '--user', 'verify', ...temps])
    for (const temp of temps) chmodSync(temp, 0o644)
    for (let i = 0; i < defs.length; i++) renameSync(temps[i], defs[i].path)
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
  await command(context, ['systemctl', '--user', 'daemon-reload'])
}

const lingerGuidance = (username: string) =>
  `warning: systemd linger is not enabled; services stop at the last logout. Run: sudo loginctl enable-linger ${username}`
export async function ensureSystemdLinger(context: SupervisorContext): Promise<void> {
  if (!context.which('loginctl')) return context.log(lingerGuidance(context.username))
  const probe = async () =>
    (await context.runner(['loginctl', 'show-user', context.username, '--property=Linger', '--value'])).stdout
      .trim()
      .toLowerCase() === 'yes'
  if (await probe()) return
  const enabled = await context.runner(['loginctl', 'enable-linger', context.username])
  if (enabled.code === 0 && (await probe())) return
  context.log(lingerGuidance(context.username))
}

function parseShow(context: SupervisorContext, component: NativeComponent, text: string): SupervisorProcess {
  const props = Object.fromEntries(
    text
      .split(/\r?\n/)
      .map((line) => line.split(/=(.*)/s).slice(0, 2))
      .filter((pair) => pair.length === 2)
  )
  // The shared process vocabulary is pm2's ('online'/'stopped'): every
  // consumer — `ficus server status`, `list`, and CI — compares against it, so
  // an active/running user unit must read as online, not as systemd prose.
  const status =
    props.LoadState === 'not-found' || !props.FragmentPath
      ? 'not registered'
      : props.ActiveState === 'active' && props.SubState === 'running'
        ? 'online'
        : props.ActiveState === 'inactive'
          ? 'stopped'
          : `${props.ActiveState ?? 'unknown'} (${props.SubState ?? 'unknown'})`
  return {
    name: instanceNames(context.label, context.identity)[component],
    status,
    pid: Number(props.MainPID ?? 0),
    cwd: context.root,
  }
}

// systemd-user deliberately relies on the registry root binding plus the
// root marker in the unit at its fixed ~/.config/systemd/user path. Installation
// verifies that marker before replacement and daemon-reloads the manager;
// uninstall verifies it before removal. launchd needs an extra live-job check
// because a stale job can keep occupying its independent label namespace even
// after the plist at the expected path changes.
export const systemdUserSupervisor: SupervisorAdapter = {
  async start(context) {
    await healthyManager(context)
    await installDefinitions(context)
    for (const component of API_FIRST)
      await command(context, ['systemctl', '--user', 'stop', systemdUserNames(context, component).unit])
    for (const component of WORKER_FIRST)
      await command(context, ['systemctl', '--user', 'enable', '--now', systemdUserNames(context, component).unit])
    await ensureSystemdLinger(context)
  },
  async stop(context) {
    await healthyManager(context)
    for (const component of API_FIRST)
      await command(context, ['systemctl', '--user', 'stop', systemdUserNames(context, component).unit])
  },
  async restart(context) {
    await healthyManager(context)
    for (const component of WORKER_FIRST)
      await command(context, ['systemctl', '--user', 'restart', systemdUserNames(context, component).unit])
  },
  async status(context) {
    await healthyManager(context)
    const rows: SupervisorProcess[] = []
    for (const component of WORKER_FIRST) {
      const names = systemdUserNames(context, component)
      const result = await context.runner([
        'systemctl',
        '--user',
        'show',
        names.unit,
        '--property=LoadState,ActiveState,SubState,MainPID,FragmentPath',
        '--no-pager',
      ])
      if (result.code !== 0) {
        throw new Error(
          `systemctl --user show ${names.unit} failed (exit ${result.code})${result.stderr ? `: ${result.stderr.trim()}` : ''}`
        )
      }
      rows.push(parseShow(context, component, result.stdout))
    }
    return rows
  },
  async logs(context, options) {
    const components = options.component === 'all' ? WORKER_FIRST : [options.component]
    const result = await context.runner(
      [
        'tail',
        '-n',
        String(options.lines),
        ...(options.follow ? ['-F'] : []),
        ...components.map((c) => nativeLogPath(context, c)),
      ],
      { inherit: true }
    )
    if (result.code !== 0) throw new Error(`tail logs failed (exit ${result.code})`)
  },
  async uninstall(context) {
    const defs = WORKER_FIRST.map((component) => systemdUserNames(context, component))
    for (const d of defs) assertOwned(d.path, context.root)
    await healthyManager(context)
    for (const component of API_FIRST)
      await command(context, ['systemctl', '--user', 'disable', '--now', systemdUserNames(context, component).unit])
    for (const d of defs) rmSync(d.path, { force: true })
    await command(context, ['systemctl', '--user', 'daemon-reload'])
    for (const d of defs) await command(context, ['systemctl', '--user', 'reset-failed', d.unit], true)
  },
}
