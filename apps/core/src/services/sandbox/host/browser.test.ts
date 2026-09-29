import { describe, expect, test, beforeEach, afterEach, spyOn } from 'bun:test'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildHostLaunchOptions,
  createHostBrowserBackend,
  launchHostChromium,
  resolveHostChromium,
  sweepStaleBrowserTokenDirs,
  type BrowserService,
  type HostBrowserEngine,
} from './browser'
import { SandboxHttpError } from '../k8s/http-client'
import type { BrowserBackend } from '../browser-backend'
import { HostSandboxManager } from './manager'

// --- resolveHostChromium fakes ---------------------------------------------

const MAC_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

function deps(opts: {
  platform?: NodeJS.Platform
  present?: string[]
  executable?: string[]
  directories?: string[]
  dirs?: Record<string, string[]>
  home?: string
}) {
  const directories = new Set(opts.directories ?? [])
  const present = new Set([...(opts.present ?? []), ...directories])
  const executable = new Set(opts.executable ?? opts.present ?? [])
  return {
    platform: opts.platform ?? 'darwin',
    exists: (p: string) => present.has(p),
    isFile: (p: string) => present.has(p) && !directories.has(p),
    isExecutable: (p: string) => executable.has(p),
    listDir: (p: string) => opts.dirs?.[p] ?? [],
    homedir: () => opts.home ?? '/Users/tester',
  }
}

// --- Playwright fakes ------------------------------------------------------

class FakePage {
  closed = false
  gotoCalls: string[] = []
  clickCalls: Array<{ selector: string }> = []
  evalCalls = 0
  private consoleHandler: ((msg: { type: () => string; text: () => string }) => void) | null = null

  on(event: string, handler: (msg: { type: () => string; text: () => string }) => void) {
    if (event === 'console') this.consoleHandler = handler
  }

  async goto(url: string) {
    this.gotoCalls.push(url)
  }

  async title() {
    return 'Fake Title'
  }

  async screenshot() {
    return Buffer.from('fake-png-bytes')
  }

  locator(selector: string) {
    return {
      click: async () => {
        this.clickCalls.push({ selector })
      },
      fill: async () => {},
      textContent: async () => `text-of-${selector}`,
    }
  }

  mouse = { click: async () => {}, wheel: async () => {} }
  keyboard = { type: async () => {} }

  async waitForTimeout() {}

  async evaluate() {
    this.evalCalls++
    return 'body-inner-text'
  }

  async close() {
    this.closed = true
  }

  emitConsole(type: string, text: string) {
    this.consoleHandler?.({ type: () => type, text: () => text })
  }
}

class FakeContext {
  pages: FakePage[] = []
  closed = false

  constructor(private readonly browser?: { dead: boolean }) {}

  async newPage() {
    // A dead browser fails every operation on its existing contexts too —
    // that is how the engine discovers a crash and self-heals.
    if (this.browser?.dead) throw new Error('Target closed')
    const page = new FakePage()
    this.pages.push(page)
    return page
  }

  async route() {}

  async close() {
    this.closed = true
  }
}

class FakeBrowser {
  contexts: FakeContext[] = []
  closed = false

  async newContext() {
    const ctx = new FakeContext()
    this.contexts.push(ctx)
    return ctx
  }

  async close() {
    this.closed = true
  }
}

/**
 * A browser with a REAL event emitter, like Playwright's: `close()` fires
 * 'disconnected', and it can also be killed underneath us (a Chrome crash).
 */
class DisconnectableBrowser {
  contexts: FakeContext[] = []
  closed = false
  dead = false
  private handlers = new Map<string, Array<(...args: unknown[]) => void>>()

  on(event: string, handler: (...args: unknown[]) => void) {
    const list = this.handlers.get(event) ?? []
    list.push(handler)
    this.handlers.set(event, list)
    return this
  }

  emit(event: string) {
    for (const handler of this.handlers.get(event) ?? []) handler()
  }

  async newContext() {
    if (this.dead) throw new Error('Target closed')
    const ctx = new FakeContext(this)
    this.contexts.push(ctx)
    return ctx
  }

  async close() {
    this.closed = true
    this.dead = true
    this.emit('disconnected')
  }
}

// --- Tests -----------------------------------------------------------------

describe('resolveHostChromium', () => {
  test('prefers FICUS_BROWSER_EXECUTABLE_PATH when it is an executable file', () => {
    const resolved = resolveHostChromium(
      { FICUS_BROWSER_EXECUTABLE_PATH: '/custom/chrome', FICUS_BROWSER_CHANNEL: 'msedge' },
      deps({ present: ['/custom/chrome', MAC_CHROME] })
    )
    expect(resolved).toEqual({ executablePath: '/custom/chrome' })
  })

  test('ignores a configured executable path that exists but is not executable', () => {
    const resolved = resolveHostChromium(
      { FICUS_BROWSER_EXECUTABLE_PATH: '/custom/chrome' },
      deps({ present: ['/custom/chrome', MAC_CHROME], executable: [MAC_CHROME] })
    )
    expect(resolved).toEqual({ executablePath: MAC_CHROME })
  })

  test('rejects a configured path that is a directory (a macOS .app bundle) and names the binary inside', () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const resolved = resolveHostChromium(
        { FICUS_BROWSER_EXECUTABLE_PATH: '/Applications/Google Chrome.app' },
        deps({ directories: ['/Applications/Google Chrome.app'], present: [MAC_CHROME] })
      )
      expect(resolved).toEqual({ executablePath: MAC_CHROME })
      const messages = warn.mock.calls.map((call) => call.join(' '))
      expect(messages.some((m) => m.includes('is a directory') && m.includes(MAC_CHROME))).toBe(true)
    } finally {
      warn.mockRestore()
    }
  })

  // `~` reaches the process as a literal character: nothing in the .env chain
  // (bun's loader, dotenv, systemd EnvironmentFile) expands it.
  test('expands a leading ~ in the configured executable path', () => {
    const chrome = join(homedir(), 'chrome')
    const resolved = resolveHostChromium(
      { FICUS_BROWSER_EXECUTABLE_PATH: '~/chrome' },
      deps({ present: [chrome, MAC_CHROME], home: homedir() })
    )
    expect(resolved).toEqual({ executablePath: chrome })
  })

  test('rejects a relative configured path', () => {
    const resolved = resolveHostChromium(
      { FICUS_BROWSER_EXECUTABLE_PATH: 'chrome' },
      deps({ present: ['chrome', MAC_CHROME] })
    )
    expect(resolved).toEqual({ executablePath: MAC_CHROME })
  })

  test('uses FICUS_BROWSER_CHANNEL ahead of the probe list', () => {
    const resolved = resolveHostChromium({ FICUS_BROWSER_CHANNEL: 'msedge' }, deps({ present: [MAC_CHROME] }))
    expect(resolved).toEqual({ channel: 'msedge' })
  })

  test('ignores an unsupported channel and falls through to the probe list', () => {
    const resolved = resolveHostChromium({ FICUS_BROWSER_CHANNEL: 'firefox' }, deps({ present: [MAC_CHROME] }))
    expect(resolved).toEqual({ executablePath: MAC_CHROME })
  })

  test('probes a linux playwright chromium install through the glob dirs', () => {
    const chrome = '/opt/tau/browser/ms-playwright/chromium-1234/chrome-linux64/chrome'
    const resolved = resolveHostChromium(
      {},
      deps({
        platform: 'linux',
        present: [chrome],
        dirs: { '/opt/tau/browser/ms-playwright': ['chromium-1234', 'ffmpeg-1000'] },
      })
    )
    expect(resolved).toEqual({ executablePath: chrome })
  })

  test('never picks the snap chromium wrapper', () => {
    const resolved = resolveHostChromium({}, deps({ platform: 'linux', present: ['/snap/bin/chromium'] }))
    expect(resolved).toBeNull()
  })

  test('returns null when nothing is configured or installed', () => {
    expect(resolveHostChromium({}, deps({ present: [] }))).toBeNull()
  })

  // call() re-resolves the browser on every 502 to distinguish "restarted"
  // from "unavailable", so an operator with a misconfigured FICUS_BROWSER_*
  // value would otherwise get the same warning on every failing request.
  // Gate it: once per distinct message per process.
  test('a FICUS_BROWSER_* misconfiguration warns exactly once across repeated resolutions', () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {})
    try {
      for (let i = 0; i < 3; i++) {
        const resolved = resolveHostChromium(
          { FICUS_BROWSER_CHANNEL: 'not-a-chromium-channel' },
          deps({ present: [MAC_CHROME] })
        )
        // Falls through to the probe list every time.
        expect(resolved).toEqual({ executablePath: MAC_CHROME })
      }
      const misconfig = warn.mock.calls
        .map((call) => call.join(' '))
        .filter((m) => m.includes('not-a-chromium-channel'))
      expect(misconfig).toHaveLength(1)
    } finally {
      warn.mockRestore()
    }
  })
})

describe('buildHostLaunchOptions', () => {
  test('runs headless with the renderer sandbox on and Playwright signal handling off', () => {
    expect(buildHostLaunchOptions({ executablePath: '/x/chrome' }, 501, { PATH: '/usr/bin:/bin' })).toEqual({
      headless: true,
      handleSIGINT: false,
      handleSIGTERM: false,
      handleSIGHUP: false,
      chromiumSandbox: true,
      executablePath: '/x/chrome',
      env: { PATH: '/usr/bin:/bin' },
    })
  })

  // Chrome renders untrusted pages; it inherits the CORE's environment unless
  // we hand it one, and that environment holds every credential Ficus has.
  test('hands Chrome a minimal env, so core secrets never reach the browser process', () => {
    const opts = buildHostLaunchOptions({ executablePath: '/x/chrome' }, 501, {
      PATH: '/usr/bin:/bin',
      HOME: '/home/tau',
      TMPDIR: '/tmp',
      LANG: 'en_US.UTF-8',
      LC_ALL: 'en_US.UTF-8',
      DISPLAY: ':0',
      WAYLAND_DISPLAY: 'wayland-0',
      XDG_RUNTIME_DIR: '/run/user/1000',
      HTTP_PROXY: 'http://proxy:8080',
      HTTPS_PROXY: 'http://proxy:8080',
      NO_PROXY: 'localhost',
      http_proxy: 'http://proxy:8080',
      https_proxy: 'http://proxy:8080',
      no_proxy: 'localhost',
      DATABASE_URL: 'postgres://canary',
      ANTHROPIC_API_KEY: 'sk-canary',
      FICUS_JWT_SECRET: 'canary',
    })
    expect(opts.env).toEqual({
      PATH: '/usr/bin:/bin',
      HOME: '/home/tau',
      TMPDIR: '/tmp',
      LANG: 'en_US.UTF-8',
      LC_ALL: 'en_US.UTF-8',
      DISPLAY: ':0',
      WAYLAND_DISPLAY: 'wayland-0',
      XDG_RUNTIME_DIR: '/run/user/1000',
      HTTP_PROXY: 'http://proxy:8080',
      HTTPS_PROXY: 'http://proxy:8080',
      NO_PROXY: 'localhost',
      http_proxy: 'http://proxy:8080',
      https_proxy: 'http://proxy:8080',
      no_proxy: 'localhost',
    })
    expect(JSON.stringify(opts)).not.toContain('canary')
  })

  test('omits the passthrough vars the source env does not have', () => {
    expect(buildHostLaunchOptions({ channel: 'chrome' }, 501, { PATH: '/usr/bin', DATABASE_URL: 'x' }).env).toEqual({
      PATH: '/usr/bin',
    })
  })

  test('drops the chromium sandbox as root, which Chrome refuses to start with', () => {
    expect(buildHostLaunchOptions({ channel: 'chrome' }, 0)).toMatchObject({
      chromiumSandbox: false,
      channel: 'chrome',
    })
  })
})

describe('host browser backend', () => {
  let tokensDir: string
  let engines: HostBrowserEngine[]
  let exitSpy: ReturnType<typeof spyOn>

  beforeEach(() => {
    tokensDir = mkdtempSync(join(tmpdir(), 'ficus-host-browser-'))
    engines = []
    // Any process.exit from the engine would take the whole test runner with
    // it — spying is both the assertion and the safety net.
    exitSpy = spyOn(process, 'exit').mockImplementation((() => undefined) as never)
  })

  afterEach(async () => {
    for (const engine of engines) await engine.shutdown()
    exitSpy.mockRestore()
    rmSync(tokensDir, { recursive: true, force: true })
  })

  function makeEngine(launch: () => Promise<unknown>, extra: Record<string, unknown> = {}) {
    const engine = createHostBrowserBackend({ launch, tokensDir, installExitHooks: false, ...extra })
    engines.push(engine)
    return engine
  }

  test('open/click/read/console round-trip through the in-process browser service', async () => {
    const browser = new FakeBrowser()
    const engine = makeEngine(async () => browser)
    const backend = engine.forSandbox('agent_abc')

    const opened = await backend.browserOpen('run-1', 'https://example.com')
    expect(opened.title).toBe('Fake Title')
    expect(opened.screenshotBase64).toBe(Buffer.from('fake-png-bytes').toString('base64'))

    const page = browser.contexts[0]!.pages[0]!
    expect(page.gotoCalls).toEqual(['https://example.com/'])

    await backend.browserClick('run-1', { selector: '#btn' })
    expect(page.clickCalls).toEqual([{ selector: '#btn' }])

    expect(await backend.browserRead('run-1')).toEqual({ text: 'body-inner-text' })
    expect(await backend.browserRead('run-1', '#title')).toEqual({ text: 'text-of-#title' })

    page.emitConsole('error', 'boom')
    expect(await backend.browserConsole('run-1')).toEqual({ entries: [{ type: 'error', text: 'boom' }] })

    expect(await backend.browserClose('run-1')).toEqual({ ok: true })
    expect(page.closed).toBe(true)
  })

  test('sends the box user under the x-ficus-box-user header', async () => {
    const seen: Request[] = []
    const engine = makeEngine(async () => new FakeBrowser(), {
      wrapEngine: (real: BrowserService): BrowserService => ({
        fetch: (request) => {
          seen.push(request)
          return real.fetch(request)
        },
        shutdown: () => real.shutdown(),
        closeContext: (boxUser) => real.closeContext(boxUser),
      }),
    })
    await engine.forSandbox('agent_abc').browserOpen('run-1', 'https://example.com')

    const boxUser = `box_${createHash('sha256').update('agent_abc').digest('hex').slice(0, 12)}`
    expect(seen).toHaveLength(1)
    expect(seen[0]!.headers.get('x-ficus-box-user')).toBe(boxUser)
    expect([...seen[0]!.headers.keys()].filter((name) => name.endsWith('-box-user'))).toEqual(['x-ficus-box-user'])
  })

  test('writes a 0600 sha256 digest token for the sandbox synthetic box user', async () => {
    const engine = makeEngine(async () => new FakeBrowser())
    await engine.forSandbox('agent_abc').browserOpen('run-1', 'https://example.com')

    const boxUser = `box_${createHash('sha256').update('agent_abc').digest('hex').slice(0, 12)}`
    const tokenPath = join(tokensDir, `${boxUser}.token`)
    expect(readFileSync(tokenPath, 'utf8')).toMatch(/^[0-9a-f]{64}\n$/)
    expect(statSync(tokenPath).mode & 0o777).toBe(0o600)
  })

  test('each sandbox gets its own browser context', async () => {
    const browser = new FakeBrowser()
    const engine = makeEngine(async () => browser)

    await engine.forSandbox('agent_one').browserOpen('run-1', 'https://example.com')
    await engine.forSandbox('agent_two').browserOpen('run-1', 'https://example.com')

    expect(browser.contexts.length).toBe(2)
    expect(browser.contexts[0]!.pages.length).toBe(1)
    expect(browser.contexts[1]!.pages.length).toBe(1)
  })

  // On the host runtime the browser runs on the user's own machine with the
  // same network reach the agent's `bash` already has, so the machine-host
  // SSRF blocklist protects nothing — and blocking loopback breaks the primary
  // use case (screenshotting the agent's own local deployment, including Ficus's
  // own http://localhost:<port>/api/app/... proxied URLs).
  test('allows a loopback URL — the host browser has the same reach as bash', async () => {
    const browser = new FakeBrowser()
    const engine = makeEngine(async () => browser)

    const opened = await engine.forSandbox('agent_abc').browserOpen('run-1', 'http://127.0.0.1:3000')

    expect(opened.title).toBe('Fake Title')
    expect(browser.contexts[0]!.pages[0]!.gotoCalls).toEqual(['http://127.0.0.1:3000/'])
  })

  test('still refuses a non-http(s) URL with a 400', async () => {
    const engine = makeEngine(async () => new FakeBrowser())

    let caught: unknown
    try {
      await engine.forSandbox('agent_abc').browserOpen('run-1', 'file:///etc/passwd')
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(SandboxHttpError)
    expect((caught as SandboxHttpError).status).toBe(400)
    expect((caught as SandboxHttpError).message).toBe('invalid url')
  })

  test('a verb for a runId with no open page surfaces as a 404 SandboxHttpError', async () => {
    const engine = makeEngine(async () => new FakeBrowser())
    const backend = engine.forSandbox('agent_abc')

    let caught: unknown
    try {
      await backend.browserScreenshot('never-opened')
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(SandboxHttpError)
    expect((caught as SandboxHttpError).status).toBe(404)
    expect((caught as SandboxHttpError).message).toBe('unknown runId')
  })

  test('a failing launch on a machine with NO browser surfaces as a 503 BROWSER_UNAVAILABLE', async () => {
    const engine = makeEngine(
      async () => {
        throw new Error('no chromium on this machine')
      },
      { resolveBrowser: () => null }
    )

    let caught: unknown
    try {
      await engine.forSandbox('agent_abc').browserOpen('run-1', 'https://example.com')
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(SandboxHttpError)
    expect((caught as SandboxHttpError).status).toBe(503)
    expect((caught as SandboxHttpError).code).toBe('BROWSER_UNAVAILABLE')
  })

  test('a failing launch on a machine that HAS a browser stays a transient 502', async () => {
    const engine = makeEngine(
      async () => {
        throw new Error('transient crash')
      },
      { resolveBrowser: () => ({ executablePath: '/x/chrome' }) }
    )

    let caught: unknown
    try {
      await engine.forSandbox('agent_abc').browserOpen('run-1', 'https://example.com')
    } catch (err) {
      caught = err
    }
    expect((caught as SandboxHttpError).status).toBe(502)
    expect((caught as SandboxHttpError).code).toBeUndefined()
  })

  // The api and the worker each build engines over a long life; one
  // process.once pair PER ENGINE is a listener leak (and Node's
  // MaxListenersExceededWarning) for hooks that all do the same job.
  test('installs the process exit hooks once per process, not once per engine', async () => {
    const before = process.listenerCount('exit')
    const beforeSigterm = process.listenerCount('SIGTERM')

    const first = createHostBrowserBackend({
      launch: async () => new FakeBrowser(),
      tokensDir: join(tokensDir, 'hooks-one'),
    })
    engines.push(first)
    await first.forSandbox('agent_one').browserOpen('run-1', 'https://example.com')
    expect(process.listenerCount('exit')).toBe(before + 1)
    expect(process.listenerCount('SIGTERM')).toBe(beforeSigterm + 1)

    await first.shutdown()
    const second = createHostBrowserBackend({
      launch: async () => new FakeBrowser(),
      tokensDir: join(tokensDir, 'hooks-two'),
    })
    engines.push(second)
    await second.forSandbox('agent_two').browserOpen('run-2', 'https://example.com')
    expect(process.listenerCount('exit')).toBe(before + 1)
    expect(process.listenerCount('SIGTERM')).toBe(beforeSigterm + 1)
  })

  test('shutdown closes the browser without the engine exiting the process', async () => {
    const browser = new DisconnectableBrowser()
    const engine = makeEngine(async () => browser)
    await engine.forSandbox('agent_abc').browserOpen('run-1', 'https://example.com')

    await engine.shutdown()

    expect(browser.closed).toBe(true)
    expect(exitSpy).not.toHaveBeenCalled()
  })

  // Stopping a sandbox must not wait for the engine's 15-min idle sweep —
  // and must not LAUNCH a browser for a sandbox that never used one.
  test('closeSandboxContext closes that sandbox context, and is a no-op when the engine never started', async () => {
    const browser = new FakeBrowser()
    const engine = makeEngine(async () => browser)

    // Before any verb, closeSandboxContext must not launch anything.
    await engine.closeSandboxContext('agent_never_started')
    expect(browser.contexts.length).toBe(0)

    await engine.forSandbox('agent_abc').browserOpen('run-1', 'https://example.com')
    await engine.forSandbox('agent_two').browserOpen('run-1', 'https://example.com')
    expect(browser.contexts.length).toBe(2)

    await engine.closeSandboxContext('agent_abc')
    expect(browser.contexts[0]!.closed).toBe(true)
    expect(browser.contexts[1]!.closed).toBe(false)
  })

  describe('stale token-dir sweep', () => {
    test('the exported sweeper removes only dead-pid dirs (EPERM counts as alive)', () => {
      const removed: string[] = []
      const probed: number[] = []
      const dead = [111, 222]
      const aliveOther = 555 // EPERM: pid exists but belongs to another user
      const kill = (pid: number, signal: 0) => {
        expect(signal).toBe(0)
        probed.push(pid)
        if (dead.includes(pid)) {
          const err = new Error('no such process') as NodeJS.ErrnoException
          err.code = 'ESRCH'
          throw err
        }
        if (pid === aliveOther) {
          const err = new Error('not permitted') as NodeJS.ErrnoException
          err.code = 'EPERM'
          throw err
        }
      }
      // Non-numeric entries must be ignored entirely (never probed, never rm'd).
      const entries = ['111', '222', '333', '444', '555', 'box_abcdef012345.token', 'not-a-pid']

      // Inject the directory listing through a readdir stub — the sweeper
      // accepts injectable rm/kill only, so the listing comes from a temp
      // tree below instead. (This test asserts the DECISIONS: which pids get
      // probed and which dirs get removed.)
      const tmpParent = mkdtempSync(join(tmpdir(), 'ficus-sweep-unit-'))
      for (const entry of entries) mkdirSync(join(tmpParent, entry), { recursive: true })
      try {
        sweepStaleBrowserTokenDirs(tmpParent, 333, { kill, rm: (p) => removed.push(p) })
        expect(probed.slice().sort((a, b) => a - b)).toEqual([111, 222, 444, 555])
        expect(removed.sort()).toEqual([join(tmpParent, '111'), join(tmpParent, '222')])
      } finally {
        rmSync(tmpParent, { recursive: true, force: true })
      }
    })

    test('ensureService sweeps dead siblings and keeps the live one when the tokens dir defaulted', async () => {
      const home = mkdtempSync(join(tmpdir(), 'ficus-host-browser-sweep-'))
      const prevHome = process.env.HOME_DIR
      process.env.HOME_DIR = home
      const tokensParent = join(home, 'host', 'browser-tokens')
      try {
        // Bun's completion promise remains observable even if this tiny child
        // exits before the next JS turn; an exit-event-only wait can miss it.
        const child = Bun.spawn(['true'], { stdout: 'ignore', stderr: 'ignore' })
        const deadPid = child.pid
        expect(await child.exited).toBe(0)
        expect(child.signalCode).toBeNull()
        mkdirSync(join(tokensParent, String(deadPid)), { recursive: true })
        mkdirSync(join(tokensParent, String(process.pid)), { recursive: true })
        const engine = createHostBrowserBackend({
          // The launch failing is fine: ensureService (and the sweep) run on
          // the way to the first verb, which then throws.
          launch: async () => {
            throw new Error('no browser')
          },
          resolveBrowser: () => null,
          installExitHooks: false,
        })
        engines.push(engine)
        await expect(engine.forSandbox('agent_abc').browserOpen('run-1', 'https://example.com')).rejects.toThrow(
          'browser unavailable on this machine'
        )
        expect(existsSync(join(tokensParent, String(deadPid)))).toBe(false)
        expect(existsSync(join(tokensParent, String(process.pid)))).toBe(true)
      } finally {
        if (prevHome === undefined) delete process.env.HOME_DIR
        else process.env.HOME_DIR = prevHome
        rmSync(home, { recursive: true, force: true })
      }
    })
  })

  test('a crashed browser relaunches on a later verb instead of exiting the process', async () => {
    const browsers: DisconnectableBrowser[] = []
    const engine = makeEngine(async () => {
      const browser = new DisconnectableBrowser()
      browsers.push(browser)
      return browser
    })
    const backend = engine.forSandbox('agent_abc')

    await backend.browserOpen('run-1', 'https://example.com')
    expect(browsers.length).toBe(1)

    // Chrome dies underneath us.
    browsers[0]!.dead = true
    browsers[0]!.emit('disconnected')

    // The engine only finds out when it next touches the browser: that verb
    // fails and resets the engine's state...
    await expect(backend.browserOpen('run-2', 'https://example.com')).rejects.toThrow('browser restarted')
    // ...and the next one relaunches. Before wrapHostBrowser, the emit above
    // would have taken the whole core process down instead.
    const reopened = await backend.browserOpen('run-3', 'https://example.com')
    expect(reopened.title).toBe('Fake Title')
    expect(browsers.length).toBe(2)
    expect(exitSpy).not.toHaveBeenCalled()
  })
})

describe('HostSandboxManager.getBrowserBackend', () => {
  let home: string
  let prevHome: string | undefined
  let manager: HostSandboxManager

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'ficus-host-browser-mgr-'))
    prevHome = process.env.HOME_DIR
    process.env.HOME_DIR = home
    manager = new HostSandboxManager({ baseEnv: () => ({ PATH: '/usr/bin:/bin', HOME: home }) })
  })

  afterEach(async () => {
    await manager.cleanup()
    if (prevHome === undefined) delete process.env.HOME_DIR
    else process.env.HOME_DIR = prevHome
    rmSync(home, { recursive: true, force: true })
  })

  test('hands out one stable backend per sandbox, and a different one per sandbox', () => {
    const first = manager.getBrowserBackend('agent_one')
    expect(typeof first?.browserOpen).toBe('function')
    expect(manager.getBrowserBackend('agent_one')).toBe(first!)
    expect(manager.getBrowserBackend('agent_two')).not.toBe(first!)
  })

  test('drops a sandbox backend when the sandbox stops or is removed', async () => {
    const stopped = manager.getBrowserBackend('agent_one')
    await manager.stopSandbox('agent_one')
    expect(manager.getBrowserBackend('agent_one')).not.toBe(stopped!)

    const removed = manager.getBrowserBackend('agent_two')
    await manager.removeSandbox('agent_two')
    expect(manager.getBrowserBackend('agent_two')).not.toBe(removed!)
  })

  // A different backend object alone proves nothing (the map is cleared
  // either way) — what matters is that the ENGINE, and with it the browser
  // process, was actually shut down.
  test('cleanup shuts the engine down, so the next backend comes from a fresh one', async () => {
    const shutdowns: string[] = []
    let built = 0
    const injected = new HostSandboxManager({
      baseEnv: () => ({ PATH: '/usr/bin:/bin', HOME: home }),
      createBrowserEngine: () => {
        const id = `engine-${++built}`
        return {
          forSandbox: () => ({ id }) as unknown as BrowserBackend,
          closeSandboxContext: async () => {},
          shutdown: async () => {
            shutdowns.push(id)
          },
        }
      },
    })
    const before = injected.getBrowserBackend('agent_one')
    await injected.cleanup()
    expect(shutdowns).toEqual(['engine-1'])

    const after = injected.getBrowserBackend('agent_one')
    expect(after).not.toBe(before!)
    expect(built).toBe(2)
    await injected.cleanup()
    expect(shutdowns).toEqual(['engine-1', 'engine-2'])
  })
})

// On host the engine's SSRF blocklist is off, so a fully offline end-to-end
// verb smoke IS possible: serve a page on 127.0.0.1 and drive the real,
// locally-installed browser through the real backend. Skipped when this
// machine has no Chrome/Chromium.
describe('real local browser', () => {
  test.skipIf(!resolveHostChromium())(
    'launches the locally installed browser and screenshots a page',
    async () => {
      const browser = await launchHostChromium()
      try {
        const page = await browser.newPage()
        await page.goto('about:blank')
        const shot = await page.screenshot({ type: 'png' })
        expect(shot.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
      } finally {
        await browser.close()
      }
    },
    120_000
  )

  // The definitive proof of this runtime's browser: a real Chrome opening a
  // real local server over loopback, through the real host backend.
  test.skipIf(!resolveHostChromium())(
    'opens a local 127.0.0.1 server end-to-end and returns its title + PNG screenshot',
    async () => {
      const server = Bun.serve({
        hostname: '127.0.0.1',
        port: 0,
        fetch: () =>
          new Response('<!doctype html><html><head><title>Ficus Host Smoke</title></head><body>hi</body></html>', {
            headers: { 'content-type': 'text/html' },
          }),
      })
      const dir = mkdtempSync(join(tmpdir(), 'ficus-host-browser-real-'))
      const engine = createHostBrowserBackend({ tokensDir: dir, installExitHooks: false })
      try {
        const opened = await engine.forSandbox('agent_real').browserOpen('run-1', `http://127.0.0.1:${server.port}/`)
        expect(opened.title).toBe('Ficus Host Smoke')
        expect(Buffer.from(opened.screenshotBase64, 'base64').subarray(0, 8)).toEqual(
          Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
        )
      } finally {
        await engine.shutdown()
        rmSync(dir, { recursive: true, force: true })
        await server.stop(true)
      }
    },
    120_000
  )
})
