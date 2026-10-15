import { describe, expect, mock, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  createDomOwnership,
  DOM_LEASE_WAIT_TIMEOUT_MS,
  DomOwnershipTimeoutError,
  withDomOwnership,
  type DomOwnershipLease,
} from './domOwnership'

const FILE = 'src/test/domOwnership.test.ts'
const pending = Symbol('pending')
const settled = <T>(promise: Promise<T>) => Promise.race([promise, Bun.sleep(30).then(() => pending)])

describe('DOM ownership lease', () => {
  test('grants a free lease at once, records its holder, and hands it over FIFO on release', async () => {
    const ownership = createDomOwnership()
    await ownership.beginTest(FILE)
    const first = await ownership.acquire()
    expect(first.holder).toMatchObject({
      file: FILE,
      test: 'grants a free lease at once, records its holder, and hands it over FIFO on release',
      scope: 'test',
    })
    expect(first.holder.stack).toContain('domOwnership.test.ts')
    expect(ownership.holder()).toBe(first.holder)

    const second = ownership.acquire()
    const third = ownership.acquire()
    expect(await settled(second)).toBe(pending)
    first.release()
    first.release() // idempotent: must not also skip the third waiter's turn
    const secondLease = (await second) as DomOwnershipLease
    expect(ownership.holder()).toBe(secondLease.holder)
    expect(await settled(third)).toBe(pending)
    secondLease.release()
    ;(await third).release()
    expect(ownership.holder()).toBeUndefined()
    await ownership.endTest()
  })

  test('a waiter on a held lease fails within the bound, naming the holder and how long it was held', async () => {
    const ownership = createDomOwnership({ waitTimeoutMs: 100 })
    await ownership.beginTest(FILE)
    const holder = await ownership.acquire()
    const startedAt = performance.now()
    const error = await ownership.acquire().catch((caught: unknown) => caught)
    const waitedMs = performance.now() - startedAt

    expect(error).toBeInstanceOf(DomOwnershipTimeoutError)
    expect(waitedMs).toBeGreaterThanOrEqual(95)
    expect(waitedMs).toBeLessThan(1_000)
    const message = (error as Error).message
    expect(message).toContain('Timed out after')
    expect(message).toContain(
      `Holder: ${FILE} > "a waiter on a held lease fails within the bound, naming the holder and how long it was held" (test scope), held for `
    )
    expect(message).toMatch(/held for \d+ms/)
    expect(message).toContain('domOwnership.test.ts:')
    expect((error as DomOwnershipTimeoutError).holder).toBe(holder.holder)

    // The timed-out waiter left the queue: releasing does not hand it the lease.
    holder.release()
    expect(ownership.holder()).toBeUndefined()
    ;(await ownership.acquire()).release()
    await ownership.endTest()
  })

  test('the default wait bound fails before Bun’s default 5s test timeout would hide the holder', () => {
    expect(DOM_LEASE_WAIT_TIMEOUT_MS).toBeGreaterThanOrEqual(1_000)
    expect(DOM_LEASE_WAIT_TIMEOUT_MS).toBeLessThan(5_000)
  })

  test('a lease still held when its test ends is reported, cleaned up by its owner, and released', async () => {
    const ownership = createDomOwnership()
    await ownership.beginTest(FILE)
    const lease = await ownership.acquire()
    const reclaim = mock(() => Bun.sleep(5))
    lease.setReclaim(reclaim)

    const leak = await ownership.endTest()
    expect(reclaim).toHaveBeenCalledTimes(1)
    expect(leak?.holder).toBe(lease.holder)
    expect(leak?.message).toContain(
      `DOM ownership lease leaked: ${FILE} > "a lease still held when its test ends is reported, cleaned up by its owner, and released" (test scope) held it for `
    )
    expect(leak?.message).toContain('its test finished while still holding it')
    expect(leak?.message).toContain('Its owner cleanup ran before the lease was released.')
    expect(ownership.holder()).toBeUndefined()

    // The next test gets the lease immediately, and the leak is reported once.
    await ownership.beginTest(FILE)
    const next = await settled(ownership.acquire())
    expect(next).not.toBe(pending)
    ;(next as DomOwnershipLease).release()
    expect(await ownership.endTest()).toBeUndefined()
  })

  test('a reclaim whose owner cleanup hangs or throws still releases the lease', async () => {
    const ownership = createDomOwnership({ reclaimTimeoutMs: 20 })
    await ownership.beginTest(FILE)
    ;(await ownership.acquire()).setReclaim(() => new Promise(() => {}))
    expect((await ownership.endTest())?.message).toContain('did not finish within 20ms')
    expect(ownership.holder()).toBeUndefined()

    await ownership.beginTest(FILE)
    ;(await ownership.acquire()).setReclaim(() => {
      throw new Error('boom')
    })
    expect((await ownership.endTest())?.message).toContain('Its owner cleanup threw (boom)')
    expect(ownership.holder()).toBeUndefined()

    await ownership.beginTest(FILE)
    await ownership.acquire()
    expect((await ownership.endTest())?.message).toContain('registered no owner cleanup')
    expect(ownership.holder()).toBeUndefined()
  })

  test('a file-scoped lease survives its own tests and is released when the next file starts', async () => {
    const ownership = createDomOwnership()
    const lease = await ownership.acquire() // beforeAll / module scope: no test is running
    expect(lease.holder.scope).toBe('file')
    expect(await ownership.beginTest(FILE)).toBeUndefined()
    expect(await ownership.endTest()).toBeUndefined()
    expect(ownership.holder()).toBe(lease.holder)

    const leak = await ownership.beginTest('src/other.test.ts')
    expect(leak?.message).toContain(`${FILE} > `)
    expect(leak?.message).toContain('(file scope)')
    expect(leak?.message).toContain('its file finished while still holding it (now running src/other.test.ts)')
    expect(ownership.holder()).toBeUndefined()
    await ownership.endTest()
  })

  test('a waiter queued by a finished test is dropped instead of being handed the lease later', async () => {
    const ownership = createDomOwnership()
    await ownership.beginTest(FILE)
    await ownership.acquire()
    const abandoned = ownership.acquire()
    await ownership.endTest()
    expect(ownership.holder()).toBeUndefined()
    expect(await settled(abandoned)).toBe(pending)

    await ownership.beginTest(FILE)
    const next = await ownership.acquire()
    expect(ownership.holder()).toBe(next.holder)
    next.release()
    await ownership.endTest()
  })

  test('withDomOwnership releases the shared lease when its body throws', async () => {
    await expect(
      withDomOwnership(async () => {
        throw new Error('body failed')
      })
    ).rejects.toThrow('body failed')
    await withDomOwnership(async () => {})
  })

  test('end to end: the preload fails the leaking test, cleans up its DOM owner, and later DOM tests still run', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dom-lease-'))
    const harness = resolve(import.meta.dir, 'domHarness.ts')
    try {
      const fixture = join(directory, 'leak.test.ts')
      await writeFile(
        fixture,
        `import { expect, test } from 'bun:test'
import { acquireDomHarness } from ${JSON.stringify(harness)}
test('forgets cleanup', async () => {
  await acquireDomHarness({ url: 'http://localhost/leak' })
})
test('times out holding the lease', async () => {
  await acquireDomHarness({ url: 'http://localhost/hang' })
  await new Promise(() => {})
}, 100)
test('a later owner still runs', async () => {
  expect(typeof document).toBe('undefined')
  const dom = await acquireDomHarness({ url: 'http://localhost/next' })
  expect(document.location.href).toBe('http://localhost/next')
  await dom.cleanup()
})
`
      )
      const child = Bun.spawn(['bun', 'test', fixture], {
        cwd: resolve(import.meta.dir, '../..'),
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const [, output, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])
      expect(code).toBe(1)
      expect(output).toContain(`DOM ownership lease leaked: ${fixture} > "forgets cleanup" (test scope) held it for`)
      expect(output).toContain(
        `DOM ownership lease leaked: ${fixture} > "times out holding the lease" (test scope) held it for`
      )
      expect(output).toContain('Its owner cleanup ran before the lease was released.')
      expect(output).toMatch(/\(fail\) forgets cleanup/)
      expect(output).toMatch(/\(fail\) times out holding the lease/)
      expect(output).toMatch(/\(pass\) a later owner still runs/)
      expect(output).toContain('1 pass')
      expect(output).toContain('2 fail')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }, 30_000)
})
