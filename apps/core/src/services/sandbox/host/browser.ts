/**
 * Browser tools on the `host` runtime.
 *
 * Every other runtime runs the browser engine INSIDE the box (the
 * `tau-browser` service on a machine host, reached over the box server's
 * `/browser/*` routes). On host there is no box — so the core drives a
 * locally installed Chrome/Chromium/Edge itself, in-process, by reusing the
 * exact same engine: `scripts/machine/browser/tau-browser.js`'s
 * `createService()`, with our own `launch` injected. That engine already
 * carries the session/caps/idle/console/SSRF behaviour the tools expect, so
 * nothing about the agent-visible contract changes.
 *
 * THIS IS THE THIRD CONSUMER of that script (after the systemd unit on a
 * machine host and the docker box), and the only one that runs it INSIDE a
 * long-lived process it does not own. The script is a byte-identical single
 * source of truth — packages/machine-image/Dockerfile COPYs it and
 * bootstrap.sh embeds it verbatim, with a test asserting the copies match —
 * so accommodation happens at the injection points, never by editing the
 * copy semantics:
 *
 *   - its disconnect policy defaults to `process.exit(1)` (correct for a
 *     unit systemd restarts, fatal for the core — a Chrome crash would kill
 *     the api or worker). We inject our own `deps.onDisconnected`, which
 *     downgrades the exit to a warn; the engine self-heals (`resetState()` +
 *     relaunch on the next verb).
 *   - its default `launch` dynamic-imports `playwright`; we always pass our
 *     own `launch`, so that branch is never evaluated.
 *
 * `playwright-core` (not `playwright`) is the dependency on purpose: it never
 * downloads a browser. We only ever drive one the operator already installed.
 */

import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import { homedir, totalmem } from 'node:os'
import { isAbsolute, join, dirname } from 'node:path'
import type { Browser } from 'playwright-core'
// Plain-JS machine script (runs directly under bun on machine hosts, no build
// step, no .d.ts) — see the header above and the script's own.
// @ts-expect-error no type declarations for this untyped machine script
import { createService } from '../../../../../../scripts/machine/browser/tau-browser.js'
import { expandTilde } from '@ficus/shared/node'
import { boxUserHeaders } from '@ficus/shared/box-user'
import { boxUnixUser } from '../../machines/box-paths'
import { getHomeDir } from '../../../lib/utils/home'
import { createLogger } from '../../../lib/infra/logger'
import { SandboxHttpError } from '../k8s/http-client'
import type { BrowserBackend } from '../browser-backend'

const log = createLogger('host-browser')

/** Playwright channels that resolve to a Chromium-family browser. */
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
 * Page budget on host is deliberately half of a machine host's: the core, its
 * agents and the operator's own desktop all share this machine's RAM.
 */
const MAX_MEMORY_HIGH_MB = 4096
const MEMORY_HIGH_RAM_FRACTION = 0.25

/** How Playwright should find the browser: an explicit binary or a channel. */
export interface HostChromium {
  executablePath?: string
  channel?: string
}

/** Injection seam for {@link resolveHostChromium} (tests fake the filesystem). */
export interface ChromiumProbeDeps {
  platform?: NodeJS.Platform
  exists?(path: string): boolean
  isFile?(path: string): boolean
  isExecutable?(path: string): boolean
  listDir?(path: string): string[]
  homedir?(): string
}

function defaultIsFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

function defaultIsExecutable(path: string): boolean {
  try {
    // Any execute bit — the core may not be the file's owner.
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
 * Candidate binaries, most-preferred first. Deliberately excludes
 * `/snap/bin/chromium`: snap confinement denies Chromium access to the
 * temporary profile directory Playwright hands it, so it fails at launch in a
 * way that looks like a Ficus bug.
 */
function probeCandidates(platform: NodeJS.Platform, home: string, listDir: (p: string) => string[]): string[] {
  if (platform === 'darwin') {
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      join(home, 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    ]
  }
  const candidates = [
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/microsoft-edge',
    '/usr/bin/brave-browser',
    '/opt/google/chrome/chrome',
  ]
  // A Playwright-managed Chromium, if the machine happens to have one (the
  // machine-host layout, then the per-user cache). `chrome-linux` was renamed
  // `chrome-linux64` in newer builds — accept both.
  for (const root of ['/opt/tau/browser/ms-playwright', join(home, '.cache/ms-playwright')]) {
    for (const entry of listDir(root)) {
      if (!entry.startsWith('chromium-')) continue
      for (const sub of listDir(join(root, entry))) {
        if (sub.startsWith('chrome-linux')) candidates.push(join(root, entry, sub, 'chrome'))
      }
      // listDir may be unreadable for the version dir; still try the two known
      // layouts directly.
      candidates.push(join(root, entry, 'chrome-linux', 'chrome'), join(root, entry, 'chrome-linux64', 'chrome'))
    }
  }
  return candidates
}

let loggedResolution = false

// Misconfiguration warnings are gated to once per message per process:
// `call()` re-resolves the browser on every 502 to distinguish "restarted"
// from "unavailable", so an operator with a bad FICUS_BROWSER_* value would
// otherwise see the same warning on every failing request.
const warnedOnce = new Set<string>()

function warnMisconfigOnce(message: string): void {
  if (warnedOnce.has(message)) return
  warnedOnce.add(message)
  log.warn(message)
}

/**
 * Which locally installed browser the host runtime should drive, or null when
 * the machine has none.
 *
 * Order: `FICUS_BROWSER_EXECUTABLE_PATH` → `FICUS_BROWSER_CHANNEL` → the
 * well-known install locations for this platform. There is deliberately NO
 * blind `{ channel: 'chrome' }` last resort: Playwright's channel resolution
 * probes the very paths this function already probes, so the only thing such
 * a fallback could change is turning a clean "browser unavailable on this
 * machine" into an opaque Playwright launch failure.
 */
export function resolveHostChromium(
  env: NodeJS.ProcessEnv = process.env,
  deps: ChromiumProbeDeps = {}
): HostChromium | null {
  const platform = deps.platform ?? process.platform
  const exists = deps.exists ?? existsSync
  const isFile = deps.isFile ?? defaultIsFile
  const isExecutable = deps.isExecutable ?? defaultIsExecutable
  const listDir = deps.listDir ?? defaultListDir
  const home = (deps.homedir ?? homedir)()

  const usable = (path: string) => exists(path) && isFile(path) && isExecutable(path)

  const resolved = ((): HostChromium | null => {
    // `~` reaches us as a literal character — nothing that produces tau's
    // environment (bun's dotenv loader, systemd's EnvironmentFile=) expands
    // it — so expand BEFORE the absolute check, or `~/chrome` is rejected as
    // "not an absolute path" and the operator's setting silently does nothing.
    const configured = env.FICUS_BROWSER_EXECUTABLE_PATH?.trim()
      ? expandTilde(env.FICUS_BROWSER_EXECUTABLE_PATH.trim())
      : undefined
    if (configured) {
      // A macOS ".app" is a DIRECTORY — the single most likely thing an
      // operator points this at — so name the real binary rather than just
      // saying "not executable".
      if (!isAbsolute(configured)) {
        warnMisconfigOnce(`FICUS_BROWSER_EXECUTABLE_PATH=${configured} is not an absolute path; ignoring it`)
      } else if (exists(configured) && !isFile(configured)) {
        warnMisconfigOnce(
          `FICUS_BROWSER_EXECUTABLE_PATH=${configured} is a directory, not a browser binary; point it at the executable inside it (e.g. "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"); ignoring it`
        )
      } else if (!usable(configured)) {
        warnMisconfigOnce(`FICUS_BROWSER_EXECUTABLE_PATH=${configured} is not an executable file; ignoring it`)
      } else {
        return { executablePath: configured }
      }
    }

    const channel = env.FICUS_BROWSER_CHANNEL?.trim()
    if (channel) {
      if (SUPPORTED_CHANNELS.has(channel)) return { channel }
      warnMisconfigOnce(`FICUS_BROWSER_CHANNEL=${channel} is not a Chromium-family Playwright channel; ignoring it`)
    }

    for (const candidate of probeCandidates(platform, home, listDir)) {
      if (usable(candidate)) return { executablePath: candidate }
    }
    return null
  })()

  if (!loggedResolution) {
    loggedResolution = true
    if (resolved) {
      log.info(`Host browser: using ${resolved.executablePath ?? `channel ${resolved.channel}`}`)
    } else {
      log.warn(
        'Host browser: no Chrome/Chromium/Edge found on this machine; browser tools will report the browser as unavailable (install Google Chrome, or set FICUS_BROWSER_EXECUTABLE_PATH)'
      )
    }
  }

  return resolved
}

export interface HostLaunchOptions extends HostChromium {
  headless: true
  /**
   * Playwright installs its own SIGINT/SIGTERM/SIGHUP handlers by default and
   * exits the process (130 on Ctrl-C). In a long-lived core that hijacks the
   * entrypoint's own graceful shutdown — our `process.once` hooks below are
   * the shutdown path instead.
   */
  handleSIGINT: false
  handleSIGTERM: false
  handleSIGHUP: false
  /** Chromium's own renderer sandbox — see {@link buildHostLaunchOptions}. */
  chromiumSandbox: boolean
  /** The ONLY variables Chrome gets — see {@link BROWSER_ENV_PASSTHROUGH}. */
  env: Record<string, string>
}

/**
 * The only environment variables the browser process inherits. Playwright
 * hands Chrome the launching process's whole environment by default; here
 * that is the CORE's, which carries the database URL, provider API keys and
 * tau's own signing secrets into a process that renders untrusted pages. Only
 * what Chrome actually needs to start and find a display passes through.
 */
const BROWSER_ENV_PASSTHROUGH = [
  'PATH',
  'HOME',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'DISPLAY',
  'WAYLAND_DISPLAY',
  'XDG_RUNTIME_DIR',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
] as const

/**
 * Launch options for the host runtime. The renderer sandbox stays ON: agent
 * pages render untrusted web content as the core's unix user, so it is the
 * only isolation boundary this runtime has. Chrome refuses to start with it
 * as uid 0 on Linux, so root (a containerised core) drops it rather than
 * failing to launch at all.
 *
 * The environment is narrowed to {@link BROWSER_ENV_PASSTHROUGH} for the same
 * reason: Chrome would otherwise inherit every secret the core holds.
 */
export function buildHostLaunchOptions(
  resolved: HostChromium,
  uid: number | undefined = process.getuid?.(),
  sourceEnv: NodeJS.ProcessEnv = process.env
): HostLaunchOptions {
  const env: Record<string, string> = {}
  for (const key of BROWSER_ENV_PASSTHROUGH) {
    const value = sourceEnv[key]
    if (value !== undefined) env[key] = value
  }
  return {
    headless: true,
    handleSIGINT: false,
    handleSIGTERM: false,
    handleSIGHUP: false,
    chromiumSandbox: uid !== 0,
    env,
    ...resolved,
  }
}

/** Launches the locally installed browser found by {@link resolveHostChromium}. */
export async function launchHostChromium(): Promise<Browser> {
  const resolved = resolveHostChromium()
  if (!resolved) throw new Error('no Chrome/Chromium/Edge installed on this machine')
  // Dynamic import so a core that never opens a browser never loads
  // playwright-core (it is `--external` in the bundle, resolved from
  // node_modules at runtime).
  const { chromium } = await import('playwright-core')
  return chromium.launch(buildHostLaunchOptions(resolved))
}

/** One in-process browser engine, handing out one backend per sandbox. */
export interface HostBrowserEngine {
  forSandbox(sandboxId: string): BrowserBackend
  /** Close one sandbox's browser context now (see the backend below). */
  closeSandboxContext(sandboxId: string): Promise<void>
  shutdown(): Promise<void>
}

export interface HostBrowserOptions {
  /** Override the browser launcher (tests inject a fake Playwright browser). */
  launch?: () => Promise<unknown>
  /** Directory holding the per-box token digests (default `<HOME_DIR>/host/browser-tokens/<pid>`). */
  tokensDir?: string
  /** Page-budget input, in MB (default: `FICUS_BROWSER_MEMORY_HIGH_MB`, else a quarter of RAM capped at 4G). */
  memoryHighMb?: number
  /** Register the process-exit shutdown hooks (default true; tests opt out).
   *
   * PROCESS-SCOPED, not engine-scoped: one `process.once('exit'|'SIGTERM')`
   * pair is registered for the whole process lifetime, and every engine that
   * asks for hooks only adds its teardown callback to the shared set. An
   * engine created by a later module still has its teardown run at exit — it
   * just never installs new process hooks. */
  installExitHooks?: boolean
  /** Whether this machine has a browser at all (default {@link resolveHostChromium}). */
  resolveBrowser?: () => HostChromium | null
  /** Wraps the engine once it is built (default: none); tests use it to observe the requests it receives. */
  wrapEngine?: (engine: BrowserService) => BrowserService
}

export interface BrowserService {
  fetch(request: Request): Promise<Response>
  shutdown(): Promise<unknown>
  /** Embedder-only close of one box user's context (the engine's new seam). */
  closeContext(boxUser: string): Promise<boolean>
}

/**
 * Teardown callbacks for every live engine that asked for exit hooks, plus a
 * ONE-TIME registration of the process hooks that run them.
 *
 * Registering `process.once('exit'|'SIGTERM')` per engine leaks a listener
 * pair per engine over the life of an api/worker (and trips Node's
 * MaxListenersExceededWarning) for hooks that all do the same job.
 *
 * The hooks are PROCESS-SCOPED: installed once, they live until the process
 * ends, and each engine only contributes its teardown to the shared set —
 * engines built later register their teardown without adding listeners.
 */
const exitTeardowns = new Set<() => void>()
let exitHooksInstalled = false

/** Registers `teardown` to run at process exit; returns its unregister. */
function registerExitTeardown(teardown: () => void): () => void {
  exitTeardowns.add(teardown)
  if (!exitHooksInstalled) {
    exitHooksInstalled = true
    const onExit = () => {
      for (const run of [...exitTeardowns]) run()
    }
    process.once('exit', onExit)
    process.once('SIGTERM', onExit)
  }
  return () => exitTeardowns.delete(teardown)
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function resolveMemoryHighMb(explicit?: number): number {
  if (explicit && explicit > 0) return explicit
  const fromEnv = Number(process.env.FICUS_BROWSER_MEMORY_HIGH_MB)
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv
  const share = Math.floor((totalmem() * MEMORY_HIGH_RAM_FRACTION) / (1024 * 1024))
  return Math.max(256, Math.min(share, MAX_MEMORY_HIGH_MB))
}

/** Liveness/rm seams so tests can drive the sweep deterministically. */
export interface SweepStaleBrowserTokenDirsDeps {
  /** Signal-0 probe: throws ESRCH for a dead pid, EPERM for a live other-user pid. */
  kill?(pid: number, signal: 0): void
  rm?(path: string): void
}

/**
 * Remove `<parent>/<pid>` token dirs left behind by cores that died without
 * running their exit hooks (OOM, `kill -9`). The live sibling must survive:
 * the api and the worker share HOME_DIR and each has its own per-pid dir.
 *
 * Only numeric entries directly under `parent` are considered; `selfPid` is
 * always skipped. EPERM from the signal-0 probe counts as ALIVE (the pid
 * exists but belongs to another user). Best effort: never throws — this is
 * hygiene, and it must not fail a browser verb.
 */
export function sweepStaleBrowserTokenDirs(
  parent: string,
  selfPid: number,
  deps: SweepStaleBrowserTokenDirsDeps = {}
): void {
  const kill = deps.kill ?? ((pid: number, signal: 0) => process.kill(pid, signal))
  const rm = deps.rm ?? ((path: string) => rmSync(path, { recursive: true, force: true }))
  try {
    let entries: string[]
    try {
      entries = readdirSync(parent)
    } catch {
      return // no parent dir (or unreadable): nothing to sweep
    }
    for (const entry of entries) {
      if (!/^\d+$/.test(entry)) continue // not a per-pid token dir
      const pid = parseInt(entry, 10)
      if (pid === selfPid) continue
      let alive: boolean
      try {
        kill(pid, 0)
        alive = true
      } catch (err) {
        alive = !(err as NodeJS.ErrnoException).code || (err as NodeJS.ErrnoException).code === 'EPERM'
        // EPERM = the pid exists but belongs to another user: treat as alive.
        // Any other code (ESRCH, EINVAL) means dead/unusable.
      }
      if (alive) continue
      const dir = join(parent, entry)
      try {
        rm(dir)
        log.info(`Host browser: swept stale token dir ${dir} (pid ${pid} is gone)`)
      } catch {
        /* best effort */
      }
    }
  } catch {
    // never fail a verb over hygiene
  }
}

/**
 * Builds the host browser engine. The underlying Playwright browser is
 * launched lazily on the first verb — a core whose agents never touch the
 * browser never starts one.
 */
export function createHostBrowserBackend(opts: HostBrowserOptions = {}): HostBrowserEngine {
  // The engine authenticates to itself with the same bearer/digest protocol
  // the machine-host service uses (it is the unmodified script). The token is
  // per-process and never leaves this process; the digest file exists only
  // because the engine reads it.
  const bearer = randomBytes(32).toString('hex')
  const digest = sha256Hex(bearer)
  // Per-PID: the api and the worker (or a second core) share HOME_DIR and
  // each has its OWN bearer — one shared directory would have them
  // overwriting each other's digests and 401ing at random.
  const tokensDir = opts.tokensDir ?? join(getHomeDir(), 'host', 'browser-tokens', String(process.pid))
  // Sweep only when the tokens dir was DEFAULTED: an injected test dir's
  // parent may hold other tests' fixtures, which are not ours to delete.
  const tokensDirDefaulted = opts.tokensDir === undefined
  const resolveBrowser = opts.resolveBrowser ?? (() => resolveHostChromium())
  const tokensWritten = new Set<string>()

  let service: BrowserService | null = null
  let unregisterExitTeardown: (() => void) | null = null

  const launch = opts.launch ?? launchHostChromium

  function ensureService(): BrowserService {
    if (service) return service
    mkdirSync(tokensDir, { recursive: true })
    chmodSync(tokensDir, 0o700) // mkdir's mode is umask-masked; this is not
    if (tokensDirDefaulted) {
      // Hard-killed cores (OOM, kill -9) leave their per-pid token dirs
      // behind; a live sibling (api + worker share HOME_DIR) must survive.
      sweepStaleBrowserTokenDirs(dirname(tokensDir), process.pid)
    }
    // createService starts its own unref'd idle-sweep timer.
    service = createService({
      // The raw launcher (no proxy): the engine's disconnect policy is
      // injectable below.
      launch,
      tokensDir,
      memoryHighMb: resolveMemoryHighMb(opts.memoryHighMb),
      // No SSRF host blocklist on the host runtime. The engine's blocklist
      // exists because on a machine host the browser is a SHARED service that
      // could otherwise be pointed at the host's own loopback/link-local/cloud
      // metadata — reach the calling box does not have. Here the browser runs
      // on the user's own machine with exactly the reach the agent's `bash`
      // already has, so the guard protects nothing while breaking the primary
      // use case: screenshotting the agent's own local deployment (including
      // Ficus's own proxied http://localhost:<port>/api/app/<id>/... URLs).
      isBlockedHost: () => false,
      // The engine's production disconnect policy is process.exit(1) (for the
      // systemd unit it restarts). In-process in the core that would kill the
      // api/worker on a Chrome crash — downgrade to a warn; the engine
      // self-heals (resetState + relaunch on the next verb).
      onDisconnected: () => log.warn('Host browser disconnected (crash or shutdown); it will relaunch on next use'),
    })
    if (opts.wrapEngine) service = opts.wrapEngine(service as BrowserService)
    if (opts.installExitHooks !== false) {
      // Best effort: both entrypoints install their own SIGTERM handler that
      // exits, so this only ever gets the chance to START closing. Safe to
      // call — shutdown() closes the browser, which fires 'disconnected',
      // which is a warn and not a process.exit thanks to the injected
      // onDisconnected seam.
      unregisterExitTeardown = registerExitTeardown(() => {
        void service?.shutdown()
        try {
          rmSync(tokensDir, { recursive: true, force: true })
        } catch {
          /* best effort */
        }
      })
    }
    return service as BrowserService
  }

  function ensureToken(boxUser: string): void {
    if (tokensWritten.has(boxUser)) return
    const path = join(tokensDir, `${boxUser}.token`)
    writeFileSync(path, `${digest}\n`, { mode: 0o600 })
    chmodSync(path, 0o600) // a pre-existing file ignores writeFileSync's mode
    tokensWritten.add(boxUser)
  }

  async function call<T>(boxUser: string, verb: string, body: Record<string, unknown>): Promise<T> {
    const engine = ensureService()
    ensureToken(boxUser)
    const response = await engine.fetch(
      new Request(`http://tau-browser/${verb}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          // K3: every box-user name, like the machine hosts' box servers.
          ...boxUserHeaders(boxUser),
          authorization: `Bearer ${bearer}`,
        },
        body: JSON.stringify(body),
      })
    )
    const payload = (await response.json().catch(() => null)) as { error?: string; code?: string } | null
    if (!response.ok) {
      // The engine reports every launch/relaunch failure as a generic 502
      // "browser restarted". Re-check the machine itself: with no browser
      // installed at all this is not a transient restart, it is the permanent
      // "browser unavailable" the tools have a dedicated message for.
      if (response.status === 502 && resolveBrowser() === null) {
        throw new SandboxHttpError('browser unavailable on this machine', 503, 'BROWSER_UNAVAILABLE')
      }
      throw new SandboxHttpError(payload?.error ?? 'browser request failed', response.status, payload?.code)
    }
    return payload as T
  }

  return {
    forSandbox(sandboxId: string): BrowserBackend {
      // A synthetic box user per sandbox — the engine keys one BrowserContext
      // (and therefore one cookie jar) off it, so agents stay isolated from
      // each other exactly as they are on box-backed runtimes.
      const boxUser = boxUnixUser(sandboxId)
      return {
        browserOpen: (runId, url) => call(boxUser, 'open', { runId, url }),
        browserClick: (runId, clickOpts) => call(boxUser, 'click', { runId, ...clickOpts }),
        browserType: (runId, typeOpts) => call(boxUser, 'type', { runId, ...typeOpts }),
        browserScroll: (runId, scrollOpts) => call(boxUser, 'scroll', { runId, ...scrollOpts }),
        browserScreenshot: (runId) => call(boxUser, 'screenshot', { runId }),
        browserRead: (runId, selector) => call(boxUser, 'read', { runId, ...(selector ? { selector } : {}) }),
        browserConsole: (runId) => call(boxUser, 'console', { runId }),
        browserClose: (runId) => call(boxUser, 'close', { runId }),
      }
    },
    async shutdown(): Promise<void> {
      const engine = service
      service = null
      unregisterExitTeardown?.()
      unregisterExitTeardown = null
      if (engine) await engine.shutdown()
    },
    async closeSandboxContext(sandboxId: string): Promise<void> {
      // Deliberately does NOT ensureService(): stopping a sandbox must never
      // LAUNCH a browser. If the engine never started there is nothing to
      // close — closeContext resolves false on an unknown user anyway.
      await service?.closeContext(boxUnixUser(sandboxId))
    },
  }
}
