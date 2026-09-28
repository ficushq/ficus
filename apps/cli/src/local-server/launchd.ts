import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs'
import { isAbsolute, join } from 'path'
import { localProcessNames, parseLaunchdJobIdentity } from '@ficus/shared'
import type { SupervisorAdapter, SupervisorContext, SupervisorProcess } from './supervisor'

export type NativeComponent = 'api' | 'worker'
const COMPONENTS_WORKER_FIRST: NativeComponent[] = ['worker', 'api']
const COMPONENTS_API_FIRST: NativeComponent[] = ['api', 'worker']

function rejectControls(value: string): string {
  if ([...value].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127))
    throw new Error('Supervisor definitions cannot contain control characters')
  return value
}

function xml(value: string): string {
  return rejectControls(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

export function bunPtyLibrary(context: Pick<SupervisorContext, 'root' | 'platform' | 'arch'>): string {
  if (!isAbsolute(context.root)) throw new Error('Supervisor checkout root must be absolute')
  if (context.platform !== 'darwin' && context.platform !== 'linux')
    throw new Error(`Unsupported native supervisor platform: ${context.platform}`)
  if (context.arch !== 'arm64' && context.arch !== 'x64')
    throw new Error(`Unsupported native supervisor architecture: ${context.arch}`)
  const ext =
    context.platform === 'darwin'
      ? context.arch === 'arm64'
        ? 'librust_pty_arm64.dylib'
        : 'librust_pty.dylib'
      : context.arch === 'arm64'
        ? 'librust_pty_arm64.so'
        : 'librust_pty.so'
  return join(context.root, 'node_modules', 'bun-pty', 'rust-pty', 'target', 'release', ext)
}

export function nativeLogPath(context: Pick<SupervisorContext, 'home' | 'label'>, component: NativeComponent): string {
  return join(context.home, '.tau', 'logs', localProcessNames(context.label)[component] + '.log')
}

export function launchdNames(context: Pick<SupervisorContext, 'home' | 'label'>, component: NativeComponent) {
  const process = localProcessNames(context.label)[component]
  const label = `ai.hiretau.${process}`
  return {
    process,
    label,
    plist: join(context.home, 'Library', 'LaunchAgents', `${label}.plist`),
    log: nativeLogPath(context, component),
  }
}

function ownershipMarker(root: string): string {
  return `tau-generated-root:${Buffer.from(root).toString('base64url')}`
}

export function launchdDefinition(context: SupervisorContext, component: NativeComponent): string {
  const names = launchdNames(context, component)
  const script = component === 'api' ? 'apps/core/dist/index.js' : 'apps/core/dist/worker.js'
  const pty = bunPtyLibrary(context)
  for (const value of [context.root, context.bunPath, context.pathEnv, pty, names.log]) rejectControls(value)
  for (const path of [context.root, context.bunPath, pty, names.log])
    if (!isAbsolute(path)) throw new Error(`Supervisor path must be absolute: ${path}`)
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- ${ownershipMarker(context.root)} -->
<plist version="1.0">
<dict>
  <key>Label</key><string>${xml(names.label)}</string>
  <key>ProgramArguments</key>
  <array><string>${xml(context.bunPath)}</string><string>run</string><string>${script}</string></array>
  <key>WorkingDirectory</key><string>${xml(context.root)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>NODE_ENV</key><string>production</string>
    <key>PATH</key><string>${xml(context.pathEnv)}</string>
    <key>BUN_PTY_LIB</key><string>${xml(pty)}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>ProcessType</key><string>Background</string>
  <key>Umask</key><integer>63</integer>
  <key>StandardOutPath</key><string>${xml(names.log)}</string>
  <key>StandardErrorPath</key><string>${xml(names.log)}</string>
</dict>
</plist>
`
}

function assertOwned(path: string, root: string): void {
  if (!existsSync(path)) return
  if (!readFileSync(path, 'utf8').includes(`<!-- ${ownershipMarker(root)} -->`)) {
    throw new Error(`Refusing to replace supervisor definition not owned by this checkout: ${path}`)
  }
}

function prepareLogs(context: SupervisorContext): void {
  const dir = join(context.home, '.tau', 'logs')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  chmodSync(dir, 0o700)
  for (const component of COMPONENTS_WORKER_FIRST) {
    const path = nativeLogPath(context, component)
    if (!existsSync(path)) writeFileSync(path, '', { mode: 0o600 })
    chmodSync(path, 0o600)
  }
}

async function success(context: SupervisorContext, command: string[], operation = command.join(' ')): Promise<string> {
  const result = await context.runner(command)
  if (result.code !== 0)
    throw new Error(`${operation} failed (exit ${result.code})${result.stderr ? `: ${result.stderr.trim()}` : ''}`)
  return result.stdout
}

async function healthyDomain(context: SupervisorContext): Promise<void> {
  await success(context, ['launchctl', 'print', `gui/${context.uid}`], 'launchd GUI domain probe')
}

async function loaded(
  context: SupervisorContext,
  component: NativeComponent
): Promise<{ loaded: boolean; stdout: string }> {
  const target = `gui/${context.uid}/${launchdNames(context, component).label}`
  const result = await context.runner(['launchctl', 'print', target])
  if (result.code === 0) return { loaded: true, stdout: result.stdout }
  // launchctl uses EX_UNAVAILABLE (113) for a service absent from a healthy domain.
  if (result.code === 113) return { loaded: false, stdout: '' }
  throw new Error(`launchctl print ${target} failed (exit ${result.code})`)
}

type PreparedDefinitions = {
  definitions: Array<{ component: NativeComponent; process: string; label: string; plist: string; log: string }>
  temps: string[]
}

async function prepareDefinitions(context: SupervisorContext): Promise<PreparedDefinitions> {
  const definitions = COMPONENTS_WORKER_FIRST.map((component) => ({ component, ...launchdNames(context, component) }))
  for (const d of definitions) assertOwned(d.plist, context.root)
  const pty = bunPtyLibrary(context)
  if (!existsSync(pty)) throw new Error(`bun-pty native library is missing: ${pty}; run bun install and retry`)
  mkdirSync(join(context.home, 'Library', 'LaunchAgents'), { recursive: true })
  prepareLogs(context)
  const temps: string[] = []
  try {
    for (const d of definitions) {
      const temp = `${d.plist}.${process.pid}.tmp`
      writeFileSync(temp, launchdDefinition(context, d.component), { mode: 0o600 })
      temps.push(temp)
      await success(context, ['plutil', '-lint', temp], `plutil validation for ${d.component}`)
      chmodSync(temp, 0o644)
    }
    return { definitions, temps }
  } catch (error) {
    for (const temp of temps) rmSync(temp, { force: true })
    throw error
  }
}

function commitDefinitions(prepared: PreparedDefinitions): void {
  for (let i = 0; i < prepared.definitions.length; i++) {
    renameSync(prepared.temps[i], prepared.definitions[i].plist)
  }
}

function cleanupDefinitions(prepared: PreparedDefinitions): void {
  for (const temp of prepared.temps) rmSync(temp, { force: true })
}

function parseStatus(context: SupervisorContext, component: NativeComponent, stdout: string): SupervisorProcess {
  const name = localProcessNames(context.label)[component]
  const rawState = stdout.match(/\bstate\s*=\s*([^\s]+)/)?.[1] ?? 'unknown'
  // Same shared vocabulary as pm2/systemd adapters: consumers compare on it.
  const state = rawState === 'running' ? 'online' : rawState
  const pid = Number(stdout.match(/\bpid\s*=\s*(\d+)/)?.[1] ?? 0)
  return { name, status: state, pid, cwd: context.root }
}

/**
 * A loaded job must positively match this checkout's binary, root, and log
 * target before any mutation. This supplements the registry's root binding and
 * the plist's root ownership marker by rejecting a stale or foreign job that
 * still occupies launchd's independent live-label namespace.
 */
function assertLoadedJobOwned(context: SupervisorContext, component: NativeComponent, stdout: string): void {
  const identity = parseLaunchdJobIdentity(stdout)
  const names = launchdNames(context, component)
  // Ownership needs positive proof from every field. If launchctl's output
  // format changes, missing parses must fail closed rather than turn this guard
  // into an absence-of-contradiction check.
  if (
    identity.program !== context.bunPath ||
    identity.workingDirectory !== context.root ||
    identity.stderrPath !== names.log
  ) {
    const reason =
      identity.program === undefined || identity.workingDirectory === undefined || identity.stderrPath === undefined
        ? 'could not verify its program, working directory, and stderr path'
        : `is loaded from another definition (program ${identity.program}, working directory ${identity.workingDirectory})`
    throw new Error(`launchd job ${names.label} ${reason}; boot it out by hand before continuing`)
  }
}

export const launchdSupervisor: SupervisorAdapter = {
  async start(context) {
    await healthyDomain(context)
    // Stage and validate both definitions before inspecting or mutating live
    // jobs. A bad destination, missing library, or invalid second plist must
    // leave a healthy loaded pair untouched.
    const prepared = await prepareDefinitions(context)
    try {
      const jobs: Array<{ component: NativeComponent; loaded: boolean; stdout: string }> = []
      for (const component of COMPONENTS_API_FIRST) {
        const job = await loaded(context, component)
        if (job.loaded) assertLoadedJobOwned(context, component, job.stdout)
        jobs.push({ component, ...job })
      }
      // Every filesystem and live-job check passed before the first bootout.
      for (const job of jobs) {
        if (job.loaded) {
          await success(context, [
            'launchctl',
            'bootout',
            `gui/${context.uid}/${launchdNames(context, job.component).label}`,
          ])
        }
      }
      commitDefinitions(prepared)
      for (const component of COMPONENTS_WORKER_FIRST) {
        await success(context, ['launchctl', 'bootstrap', `gui/${context.uid}`, launchdNames(context, component).plist])
      }
    } finally {
      cleanupDefinitions(prepared)
    }
  },
  async stop(context) {
    await healthyDomain(context)
    const jobs: Array<{ component: NativeComponent; loaded: boolean; stdout: string }> = []
    for (const component of COMPONENTS_API_FIRST) {
      const job = await loaded(context, component)
      if (job.loaded) assertLoadedJobOwned(context, component, job.stdout)
      jobs.push({ component, ...job })
    }
    for (const job of jobs) {
      if (job.loaded) {
        await success(context, [
          'launchctl',
          'bootout',
          `gui/${context.uid}/${launchdNames(context, job.component).label}`,
        ])
      }
    }
  },
  async restart(context) {
    await healthyDomain(context)
    const jobs: Array<{
      component: NativeComponent
      names: ReturnType<typeof launchdNames>
      loaded: boolean
      stdout: string
    }> = []
    for (const component of COMPONENTS_WORKER_FIRST) {
      const names = launchdNames(context, component)
      const job = await loaded(context, component)
      if (job.loaded) assertLoadedJobOwned(context, component, job.stdout)
      else assertOwned(names.plist, context.root)
      jobs.push({ component, names, ...job })
    }
    for (const job of jobs) {
      if (job.loaded) {
        await success(context, ['launchctl', 'kickstart', '-k', `gui/${context.uid}/${job.names.label}`])
      } else {
        await success(context, ['launchctl', 'bootstrap', `gui/${context.uid}`, job.names.plist])
      }
    }
  },
  async status(context) {
    await healthyDomain(context)
    const rows: SupervisorProcess[] = []
    for (const component of COMPONENTS_WORKER_FIRST) {
      const state = await loaded(context, component)
      rows.push(
        state.loaded
          ? parseStatus(context, component, state.stdout)
          : { name: localProcessNames(context.label)[component], status: 'not registered', pid: 0, cwd: context.root }
      )
    }
    return rows
  },
  async logs(context, options) {
    const components = options.component === 'all' ? COMPONENTS_WORKER_FIRST : [options.component]
    const command = [
      'tail',
      '-n',
      String(options.lines),
      ...(options.follow ? ['-F'] : []),
      ...components.map((c) => nativeLogPath(context, c)),
    ]
    const result = await context.runner(command, { inherit: true })
    if (result.code !== 0) throw new Error(`tail logs failed (exit ${result.code})`)
  },
  async uninstall(context) {
    const definitions = COMPONENTS_WORKER_FIRST.map((component) => launchdNames(context, component))
    for (const d of definitions) assertOwned(d.plist, context.root)
    await healthyDomain(context)
    const jobs: Array<{ component: NativeComponent; loaded: boolean; stdout: string }> = []
    for (const component of COMPONENTS_API_FIRST) {
      const job = await loaded(context, component)
      if (job.loaded) assertLoadedJobOwned(context, component, job.stdout)
      jobs.push({ component, ...job })
    }
    for (const job of jobs) {
      if (job.loaded) {
        await success(context, [
          'launchctl',
          'bootout',
          `gui/${context.uid}/${launchdNames(context, job.component).label}`,
        ])
      }
    }
    for (const d of definitions) rmSync(d.plist, { force: true })
  },
}
