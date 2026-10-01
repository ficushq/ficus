import { existsSync, readFileSync, readdirSync, statSync } from 'fs'
import { join } from 'path'
import { homedir, userInfo } from 'os'
import { expandTilde } from '@ficus/shared/node'
import { DEFAULT_INSTANCE } from './instance'
import type { Runner } from './runner'
import type { SetupOptions } from './types'

export interface PreflightDeps {
  runner: Runner
  platform: NodeJS.Platform
  which(cmd: string): string | null
  nodeVersion(): Promise<string | null>
  bunVersion(): string
  pinnedBunVersion(): string
  browserPaths(): string[]
  /** True inside WSL (checked via /proc/version). */
  wsl(): boolean
  /** True when a systemd init system is running (/run/systemd/system exists). */
  systemdActive(): boolean
  username(): string
}

export interface PreflightResult {
  failures: string[]
  warnings: string[]
}

/**
 * Playwright channels that resolve to a Chromium-family browser.
 * Mirrors apps/core/src/services/sandbox/host/browser.ts line 51-61 and must be kept in sync.
 */
const SUPPORTED_CHANNELS = new Set([
  'chrome',
  'chrome-beta',
  'chrome-dev',
  'chrome-canary',
  'msedge',
  'msedge-beta',
  'msedge-dev',
  'msedge-canary',
  'chromium',
])

/**
 * Static browser probe candidates. Mirrors apps/core/src/services/sandbox/host/browser.ts
 * and must be kept in sync. This list is incomplete; defaultPreflightDeps also probes
 * home-relative paths (~/Applications on darwin) and Playwright-managed Chromium.
 * Snap chromium is deliberately excluded (snap confinement breaks Playwright).
 */
export const BROWSER_CANDIDATES: Record<string, string[]> = {
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  ],
  linux: [
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/microsoft-edge',
    '/usr/bin/brave-browser',
    '/opt/google/chrome/chrome',
  ],
}

function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

function isExecutable(path: string): boolean {
  try {
    return (statSync(path).mode & 0o111) !== 0
  } catch {
    return false
  }
}

function defaultListDir(path: string): string[] {
  try {
    return readdirSync(path)
  } catch {
    return []
  }
}

/**
 * Candidate binaries matching the core's probeCandidates (lines 117-151).
 * Includes static paths plus dynamic discovery of Playwright-managed Chromium
 * and home-relative paths.
 */
function probeCandidates(platform: NodeJS.Platform, home: string, listDir: (p: string) => string[]): string[] {
  const candidates: string[] = [...(BROWSER_CANDIDATES[platform] ?? [])]

  // Home-relative path (darwin only, per the core)
  if (platform === 'darwin') {
    candidates.splice(1, 0, join(home, 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'))
  }

  // Playwright-managed Chromium, if present
  for (const root of ['/opt/ficus/browser/ms-playwright', join(home, '.cache/ms-playwright')]) {
    for (const entry of listDir(root)) {
      if (!entry.startsWith('chromium-')) continue
      for (const sub of listDir(join(root, entry))) {
        if (sub.startsWith('chrome-linux')) candidates.push(join(root, entry, sub, 'chrome'))
      }
      // Try the two known layouts directly even if version dir is unreadable
      candidates.push(join(root, entry, 'chrome-linux', 'chrome'), join(root, entry, 'chrome-linux64', 'chrome'))
    }
  }

  return candidates
}

export function defaultPreflightDeps(
  root: string,
  runner: Runner,
  env: NodeJS.ProcessEnv = process.env
): PreflightDeps {
  const getHomedir = () => {
    const envHome = env.HOME || env.USERPROFILE
    return envHome || homedir()
  }
  const getExists = (path: string) => existsSync(path)
  const getListDir = defaultListDir

  return {
    runner,
    platform: process.platform,
    which: (cmd) => Bun.which(cmd),
    nodeVersion: async () => {
      if (!Bun.which('node')) return null
      const result = await runner(['node', '-p', 'process.versions.node'])
      return result.code === 0 ? result.stdout.trim() : null
    },
    bunVersion: () => Bun.version,
    pinnedBunVersion: () => {
      const file = join(root, '.bun-version')
      return existsSync(file) ? readFileSync(file, 'utf8').trim() : Bun.version
    },
    username: () => env.USER ?? userInfo().username,
    browserPaths: () => {
      const paths: string[] = []

      // Order per core's resolveHostChromium (lines ~179-213):
      // 1. FICUS_BROWSER_EXECUTABLE_PATH (with tilde expansion)
      const configured = env.FICUS_BROWSER_EXECUTABLE_PATH?.trim()
      const expanded = configured ? expandTilde(configured) : undefined
      if (expanded && getExists(expanded) && isFile(expanded) && isExecutable(expanded)) {
        return [expanded]
      }

      // 2. FICUS_BROWSER_CHANNEL (validate against SUPPORTED_CHANNELS)
      const channel = env.FICUS_BROWSER_CHANNEL?.trim()
      if (channel && SUPPORTED_CHANNELS.has(channel)) {
        return [`channel:${channel}`]
      }

      // 3. Scan candidates
      const home = getHomedir()
      const candidates = probeCandidates(process.platform, home, getListDir)
      for (const candidate of candidates) {
        if (getExists(candidate) && isFile(candidate) && isExecutable(candidate)) {
          paths.push(candidate)
        }
      }
      return paths
    },
    wsl: () => {
      try {
        return readFileSync('/proc/version', 'utf8').toLowerCase().includes('microsoft')
      } catch {
        return false
      }
    },
    systemdActive: () => existsSync('/run/systemd/system'),
  }
}

export async function runPreflight(opts: SetupOptions, deps: PreflightDeps): Promise<PreflightResult> {
  const failures: string[] = []
  const warnings: string[] = []

  if (deps.platform !== 'darwin' && deps.platform !== 'linux') {
    failures.push(
      `This installer supports macOS or Linux (got ${deps.platform}). ` +
        `Windows runs through WSL 2: from PowerShell run \`wsl --install -d Ubuntu-24.04\`, reboot, then inside WSL: ` +
        '`curl -fsSL https://ficus.sh/cli/setup.sh | bash`. See docs/wiki/sandbox-runtimes.md.'
    )
    return { failures, warnings }
  }

  const pinned = deps.pinnedBunVersion()
  if (compareVersions(deps.bunVersion(), pinned) < 0) {
    failures.push(
      `bun ${deps.bunVersion()} is older than the pinned ${pinned} — upgrade with \`bun upgrade\` or the official installer.`
    )
  }
  const node = await deps.nodeVersion()
  if (!node || !/^\d+\.\d+\.\d+$/.test(node) || compareVersions(node, '22.19.0') < 0) {
    failures.push(
      `Node.js 22.19.0 or newer is required to build Ficus and its embedded docs (found ${node || 'no working node'}). ` +
        'Install Node.js 24 LTS from https://nodejs.org and ensure node is on PATH before running setup again.'
    )
  }
  if (!deps.which('git')) failures.push('git is required (https://git-scm.com).')

  if (opts.supervisor === 'launchd') {
    if (deps.platform !== 'darwin') failures.push('The launchd supervisor is available only on macOS.')
    else if (!deps.which('launchctl')) failures.push('launchctl is required for the launchd supervisor.')
    else if ((await deps.runner(['launchctl', 'print', `gui/${process.getuid?.() ?? 0}`])).code !== 0) {
      failures.push('launchd has no usable GUI login domain; run setup from a logged-in macOS GUI session.')
    }
  } else if (opts.supervisor === 'systemd-user') {
    if (deps.platform !== 'linux') failures.push('The systemd-user supervisor is available only on Linux.')
    else if (!deps.which('systemctl')) failures.push('systemctl is required for the systemd-user supervisor.')
    else if ((await deps.runner(['systemctl', '--user', 'show-environment'])).code !== 0) {
      failures.push(
        'The systemd user bus is unavailable; start a user session and ensure XDG_RUNTIME_DIR is configured.'
      )
    }
    if (!deps.which('loginctl')) {
      warnings.push(
        `systemd linger is not enabled; services stop at the last logout. Run: sudo loginctl enable-linger ${deps.username()}`
      )
    }
  }

  const needsDocker = opts.databaseMode === 'compose' || opts.runtime !== 'host'
  if (needsDocker) {
    if (!deps.which('docker')) {
      failures.push(
        `Docker is required for ${opts.databaseMode === 'compose' ? 'the local PostgreSQL container' : `the ${opts.runtime} runtime`} (https://docs.docker.com/get-docker/).`
      )
    } else {
      const info = await deps.runner(['docker', 'info'])
      if (info.code !== 0) failures.push('`docker info` failed — start Docker Desktop / the docker daemon and retry.')
    }
  }

  if (opts.runtime === 'docker-sysbox') {
    if (deps.platform !== 'linux') {
      failures.push('docker-sysbox needs Linux with sysbox installed; on macOS choose docker-socket or host.')
    } else if (deps.which('docker')) {
      // WSL disables systemd by default; sysbox's services need it, so say
      // how to enable it before pointing at the bootstrap.
      if (deps.wsl() && !deps.systemdActive()) {
        failures.push(
          'sysbox needs systemd, which WSL disables by default: add `[boot]\nsystemd=true` to /etc/wsl.conf, ' +
            'run `wsl --shutdown` from PowerShell and reopen the distro, then run `ficus server bootstrap-sysbox` ' +
            '(docs/wiki/sandbox-runtimes.md#installing-sysbox), or choose docker-socket.'
        )
      }
      const rt = await deps.runner(['docker', 'info', '--format', '{{json .Runtimes}}'])
      if (!rt.stdout.includes('sysbox-runc')) {
        failures.push(
          'sysbox is not installed — run `ficus server bootstrap-sysbox` to install it ' +
            '(docs/wiki/sandbox-runtimes.md#installing-sysbox), or choose docker-socket.'
        )
      }
    }
  }

  if (opts.runtime === 'k3d') {
    for (const cmd of ['k3d', 'kubectl']) {
      if (!deps.which(cmd))
        failures.push(`${cmd} is required for the k3d runtime (macOS: \`brew install ${cmd}\`; see https://k3d.io).`)
    }
    // One cluster (`tau-dev`) with `~/.tau` bind-mounted into it: neither is
    // per-instance, so a labelled instance would share the default's workspace.
    if (opts.instance !== DEFAULT_INSTANCE) {
      failures.push(
        `the k3d runtime shares ~/.tau with the cluster (k3d bind-mounts it), so it is only available on the default instance — set up k3d without --instance, or pick host/docker-socket for "${opts.instance}"`
      )
    }
  }

  if (opts.runtime === 'host') {
    if (!deps.which('tmux'))
      warnings.push(
        'tmux is not installed — agents cannot run local deployments until it is (macOS: `brew install tmux`).'
      )
    if (deps.browserPaths().length === 0) {
      warnings.push(
        'No Chrome/Chromium/Edge/Brave found — browser tools will answer "unavailable" until one is installed or FICUS_BROWSER_EXECUTABLE_PATH is set (docs/wiki/host-runtime.md#browser-tools).'
      )
    }
  }

  return { failures, warnings }
}
