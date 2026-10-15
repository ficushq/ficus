import { readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'

/**
 * Process-wide DOM ownership lease.
 *
 * Every web test file runs in one `bun test` process, and Happy DOM owners
 * install process-global descriptors (`window`, `document`, timers, ...), so
 * only one owner may hold them at a time. Waiters queue FIFO.
 *
 * A lease that is never released used to block every later waiter forever,
 * turning one leaked owner into a CI job that hangs until its time limit. The
 * lease therefore records who holds it, bounds how long a waiter waits, and the
 * test preload (src/test-setup.ts) reclaims a lease that outlives its test or
 * file and fails the test that leaked it.
 */

/**
 * How long a waiter may wait before failing with the holder named.
 *
 * Bun runs tests serially, and the preload reclaims a lease left over by a
 * finished test, so a legitimate waiter only ever waits for another owner in
 * the same test to finish (a test that deliberately queues a second owner, or a
 * cleanup still settling its act() and macrotask turns). Those waits take
 * milliseconds, so 2.5s leaves several hundred times that as headroom for a
 * slow CI box. It must also stay below Bun's default 5s test and hook timeout:
 * a waiter killed by that timeout reports nothing about the holder.
 */
export const DOM_LEASE_WAIT_TIMEOUT_MS = 2_500

/** How long a leak reclaim waits for the leaked owner's own cleanup before releasing anyway. */
export const DOM_LEASE_RECLAIM_TIMEOUT_MS = 1_000

export type DomLeaseScope = 'test' | 'file'

export type DomLeaseHolder = {
  /** Test file (relative to apps/web) that requested the lease. */
  file: string
  /** Best-effort name of the enclosing test, read from the acquisition site. */
  test: string
  /** `test` when acquired inside a running test, `file` when acquired in beforeAll or at module scope. */
  scope: DomLeaseScope
  /** performance.now() when the lease was granted. */
  acquiredAt: number
  /** Exact acquisition stack; the ground truth when the test name is ambiguous. */
  stack: string
}

export type DomOwnershipLease = {
  readonly holder: DomLeaseHolder
  /** Idempotent. Hands the lease to the next waiter. */
  release(): void
  /** Registers how to tear the owner down if the lease leaks (the DOM harness registers its cleanup). */
  setReclaim(reclaim: () => unknown): void
}

export type DomLeaseLeak = { holder: DomLeaseHolder; heldMs: number; message: string }

export class DomOwnershipTimeoutError extends Error {
  constructor(
    readonly waiter: DomLeaseHolder,
    readonly holder: DomLeaseHolder | undefined,
    waitedMs: number
  ) {
    super(
      `Timed out after ${waitedMs}ms waiting for the DOM ownership lease.\n` +
        `Waiter: ${describeHolder(waiter)}\n` +
        (holder
          ? `Holder: ${describeHolder(holder)}, held for ${Math.round(performance.now() - holder.acquiredAt)}ms ` +
            `without releasing it (its cleanup did not run or did not finish).\n` +
            `Holder acquired the lease at:\n${holder.stack}`
          : 'No holder is recorded.')
    )
    this.name = 'DomOwnershipTimeoutError'
  }
}

type Lease = DomOwnershipLease & {
  testRun: number | undefined
  reclaim?: () => unknown
  reclaiming?: Promise<DomLeaseLeak>
  released: boolean
}
type Waiter = {
  site: DomLeaseHolder
  testRun: number | undefined
  grant(lease: Lease): void
  timer: ReturnType<typeof setTimeout>
}

// Captured at module load (the test preload imports this module before any DOM
// owner exists). A DOM owner replaces the global timers with its window's, and
// a waiter's timer must neither be cancelled by that owner's cleanup nor be
// counted as pending window work.
const nativeSetTimeout = globalThis.setTimeout
const nativeClearTimeout = globalThis.clearTimeout

/**
 * Creates an independent lease. The module exports one process-wide instance;
 * separate instances exist so the lease itself can be tested without touching it.
 */
export function createDomOwnership({
  waitTimeoutMs = DOM_LEASE_WAIT_TIMEOUT_MS,
  reclaimTimeoutMs = DOM_LEASE_RECLAIM_TIMEOUT_MS,
}: { waitTimeoutMs?: number; reclaimTimeoutMs?: number } = {}) {
  let holder: Lease | undefined
  const waiters: Waiter[] = []
  let testRunCounter = 0
  let currentTestRun: number | undefined

  /**
   * A request made inside a test that has since finished. Bun abandoned that
   * test's body (it timed out), so nobody would ever release a lease handed to it.
   */
  function isAbandoned(testRun: number | undefined) {
    return testRun !== undefined && testRun !== currentTestRun
  }

  function grant(site: DomLeaseHolder, testRun: number | undefined): Lease {
    const lease: Lease = {
      holder: { ...site, acquiredAt: performance.now() },
      testRun,
      released: false,
      release() {
        if (lease.released) return
        lease.released = true
        if (holder !== lease) return
        holder = undefined
        let next = waiters.shift()
        while (next && isAbandoned(next.testRun)) {
          nativeClearTimeout(next.timer)
          next = waiters.shift()
        }
        if (!next) return
        nativeClearTimeout(next.timer)
        next.grant(grant(next.site, next.testRun))
      },
      setReclaim(reclaim) {
        lease.reclaim = reclaim
      },
    }
    holder = lease
    return lease
  }

  /** Reports a leak once: a concurrent caller waits for the same reclaim but gets no duplicate report. */
  async function reclaim(lease: Lease, reason: string): Promise<DomLeaseLeak | undefined> {
    if (lease.reclaiming) {
      await lease.reclaiming
      return undefined
    }
    lease.reclaiming = forceRelease(lease, reason)
    return lease.reclaiming
  }

  async function forceRelease(lease: Lease, reason: string): Promise<DomLeaseLeak> {
    const heldMs = Math.round(performance.now() - lease.holder.acquiredAt)
    let teardown = 'Its owner cleanup ran before the lease was released.'
    if (!lease.reclaim) {
      teardown = 'It registered no owner cleanup, so DOM globals may still be installed.'
    } else {
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        const outcome = await Promise.race([
          Promise.resolve()
            .then(lease.reclaim)
            .then(() => 'done' as const),
          new Promise<'timeout'>((resolveTimeout) => {
            timer = nativeSetTimeout(() => resolveTimeout('timeout'), reclaimTimeoutMs)
          }),
        ])
        if (outcome === 'timeout')
          teardown = `Its owner cleanup did not finish within ${reclaimTimeoutMs}ms, so the lease was released anyway.`
      } catch (error) {
        teardown = `Its owner cleanup threw (${error instanceof Error ? error.message : String(error)}), so the lease was released anyway.`
      } finally {
        nativeClearTimeout(timer)
      }
    }
    lease.release()
    const message =
      `DOM ownership lease leaked: ${describeHolder(lease.holder)} held it for ${heldMs}ms and ${reason}. ` +
      `${teardown} It has been released so later tests can run. Clean up every DOM owner, ` +
      `including when the test throws or times out.\nHolder acquired the lease at:\n${lease.holder.stack}`
    return { holder: lease.holder, heldMs, message }
  }

  /** A file-scoped lease is stale once another file is running: Bun runs files one at a time. */
  function reclaimIfStale(file: string) {
    if (!holder || holder.released || holder.holder.scope !== 'file' || holder.holder.file === file)
      return Promise.resolve(undefined)
    return reclaim(holder, `its file finished while still holding it (now running ${file})`)
  }

  return {
    /** Acquires exclusive ownership, or rejects with DomOwnershipTimeoutError naming the holder. */
    async acquire(): Promise<DomOwnershipLease> {
      const site = acquisitionSite(new Error().stack ?? '', currentTestRun === undefined ? 'file' : 'test')
      const testRun = currentTestRun
      const staleLeak = await reclaimIfStale(site.file)
      if (staleLeak) console.error(staleLeak.message)
      // Never settles: the abandoned test body must not continue as a DOM owner.
      if (isAbandoned(testRun)) return new Promise<never>(() => {})
      if (!holder && waiters.length === 0) return grant(site, testRun)
      return new Promise<DomOwnershipLease>((resolveLease, reject) => {
        const queuedAt = performance.now()
        const waiter: Waiter = {
          site,
          testRun,
          grant: resolveLease,
          timer: nativeSetTimeout(() => {
            waiters.splice(waiters.indexOf(waiter), 1)
            reject(new DomOwnershipTimeoutError(site, holder?.holder, Math.round(performance.now() - queuedAt)))
          }, waitTimeoutMs),
        }
        waiters.push(waiter)
      })
    },

    /** Called by the test preload before each test. Reports a file-scoped lease that outlived its file. */
    beginTest(file = displayPath(Bun.main)): Promise<DomLeaseLeak | undefined> {
      currentTestRun = ++testRunCounter
      return reclaimIfStale(file)
    },

    /**
     * Called by the test preload after each test, after the file's own afterEach
     * hooks. Tests run serially, so once a test has finished any lease taken
     * inside a test is stale, and so is any waiter it queued: Bun abandoned its
     * body when it timed out, so it must never be handed the lease later.
     */
    endTest(): Promise<DomLeaseLeak | undefined> {
      currentTestRun = undefined
      for (const waiter of waiters.filter((entry) => isAbandoned(entry.testRun))) {
        nativeClearTimeout(waiter.timer)
        waiters.splice(waiters.indexOf(waiter), 1)
      }
      if (!holder || holder.released || holder.testRun === undefined) return Promise.resolve(undefined)
      return reclaim(holder, 'its test finished while still holding it')
    },

    holder(): DomLeaseHolder | undefined {
      return holder?.holder
    },
  }
}

/** The process-wide lease shared by every DOM owner in this bun test process. */
export const domOwnership = createDomOwnership()

/** Acquires exclusive ownership of process-global DOM descriptors, or fails with the holder named. */
export function acquireDomOwnershipLease(): Promise<DomOwnershipLease> {
  return domOwnership.acquire()
}

export async function withDomOwnership<T>(body: () => Promise<T>): Promise<T> {
  const lease = await acquireDomOwnershipLease()
  try {
    return await body()
  } finally {
    lease.release()
  }
}

function describeHolder(site: DomLeaseHolder) {
  return `${site.file} > ${JSON.stringify(site.test)} (${site.scope} scope)`
}

const webRoot = resolve(import.meta.dir, '../..')

function displayPath(path: string) {
  const relativePath = relative(webRoot, path)
  return relativePath.startsWith('..') ? path : relativePath
}

const stackFrame = /\(?((?:\/|[A-Za-z]:\\)[^():]+):(\d+):\d+\)?$/
const testFile = /\.(test|spec)\.[cm]?[jt]sx?$/

/** Records where the lease was requested: requesting test file, enclosing test name and the stack. */
function acquisitionSite(stack: string, scope: DomLeaseScope): DomLeaseHolder {
  const lines = stack.split('\n').slice(1)
  const frames = lines
    .map((line) => stackFrame.exec(line.trim()))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => ({ path: match[1]!, line: Number(match[2]) }))
  // Prefer the running test file; fall back to any test-file frame (an owner
  // started by async work that outlived an earlier file's test).
  const running = frames.filter((frame) => frame.path === Bun.main)
  const outermost = (running.length ? running : frames.filter((frame) => testFile.test(frame.path))).at(-1)
  return {
    file: displayPath(outermost?.path ?? Bun.main),
    test: outermost ? enclosingTestName(outermost.path, outermost.line) : 'unknown test (see stack)',
    scope,
    acquiredAt: performance.now(),
    stack: lines.join('\n'),
  }
}

const sources = new Map<string, string[]>()
const testDeclaration = /\b(?:test|it)(?:\.\w+)*\(\s*(['"`])((?:\\.|(?!\1).)*)\1/

/** Best effort: the nearest test(...) declaration at or above the outermost test-file frame. */
function enclosingTestName(path: string, line: number) {
  let source = sources.get(path)
  if (!source) {
    try {
      source = readFileSync(path, 'utf8').split('\n')
    } catch {
      source = []
    }
    sources.set(path, source)
  }
  for (let index = Math.min(line, source.length) - 1; index >= 0; index--) {
    const match = testDeclaration.exec(source[index]!)
    if (match) return match[2]!
  }
  return `unknown test (line ${line}; see stack)`
}
