import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createHash } from 'crypto'
import { lstatSync, mkdtempSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from 'fs'
import { realpath, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { basename, dirname, join } from 'path'

const sha256 = (value: Buffer) => createHash('sha256').update(value).digest('hex')
const identity = (value: Buffer) => ({ bytes: value.byteLength, sha256: sha256(value) })

type FileIdentity = { bytes: number; sha256: string }
type AtomicWriteRequest = {
  path: string
  allowedRoots: string[]
  content: Buffer
  mode?: number
  expectedOriginal?: FileIdentity
  expectedResult?: FileIdentity
}
type StageHandle = {
  writeAll: (content: Buffer) => Promise<void>
  readAt: (offset: number, length: number) => Promise<Buffer>
  chmod: (mode: number) => Promise<void>
  sync: () => Promise<void>
  stat: () => Promise<{ dev: number | bigint; ino: number | bigint; mode: number }>
  close: () => Promise<void>
}
type DestinationState = {
  identity: FileIdentity
  mode: number
}
type AtomicWriteOperations = {
  resolveDestination: (path: string, allowedRoots: string[]) => Promise<string>
  withPathMutationQueue: <T>(key: string, work: () => Promise<T>) => Promise<T>
  readDestination: (path: string) => Promise<DestinationState | undefined>
  openStage: (path: string, flags: 'wx+', mode: 0o600) => Promise<StageHandle>
  statPath: (path: string) => Promise<{ dev: number | bigint; ino: number | bigint; mode: number }>
  readPath: (path: string) => Promise<Buffer>
  rename: (from: string, to: string) => Promise<void>
  removeOwnedStage: (path: string) => Promise<void>
  capturedUmask: number
}

async function atomicModule() {
  try {
    return await import('./atomic-write')
  } catch (cause) {
    throw new Error('COOPERATING_WRITER_UNAVAILABLE_FOR_TDD', { cause })
  }
}

let testDir: string

beforeEach(() => {
  testDir = realpathSync(mkdtempSync(join(tmpdir(), 'atomic-publication-')))
})

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true })
})

function request(path: string, content: Buffer, rest: Partial<AtomicWriteRequest> = {}): AtomicWriteRequest {
  return { path, allowedRoots: [testDir], content, ...rest }
}

async function writeAtomically(writeRequest: AtomicWriteRequest, overrides: Partial<AtomicWriteOperations> = {}) {
  const module = await atomicModule()
  const operations = { ...module.createNodeAtomicWriteOperations(), ...overrides }
  return module.atomicVerifiedWrite(writeRequest, operations)
}

async function withNodeOperations<T>(work: (operations: AtomicWriteOperations) => Promise<T>): Promise<T> {
  const module = await atomicModule()
  return work(module.createNodeAtomicWriteOperations())
}

async function captureRejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (error) {
    return error
  }
}

function expectBoundedError(rejection: unknown, category: RegExp, forbiddenContent: string[] = []): Error {
  expect(rejection).toBeInstanceOf(Error)
  const error = rejection as Error
  expect(error.message).toMatch(category)
  expect(Buffer.byteLength(error.message)).toBeLessThanOrEqual(512)
  for (const forbidden of forbiddenContent) expect(error.message).not.toContain(forbidden)
  return error
}

async function expectBoundedRejection(
  promise: Promise<unknown>,
  category: RegExp,
  forbiddenContent: string[] = []
): Promise<Error> {
  return expectBoundedError(await captureRejection(promise), category, forbiddenContent)
}

function mutationBoundary<T>(label: string, assertion: () => T): T {
  try {
    return assertion()
  } catch (error) {
    throw new Error(`MUTATION_BOUNDARY:${label}\n${error instanceof Error ? error.message : 'assertion failed'}`, {
      cause: error,
    })
  }
}

async function asyncMutationBoundary<T>(label: string, assertion: () => Promise<T>): Promise<T> {
  try {
    return await assertion()
  } catch (error) {
    throw new Error(`MUTATION_BOUNDARY:${label}\n${error instanceof Error ? error.message : 'assertion failed'}`, {
      cause: error,
    })
  }
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function expectBytes(path: string, expected: Buffer) {
  expect(Buffer.compare(readFileSync(path), expected)).toBe(0)
}

describe('canonical publication entry', () => {
  test('direct path and final symlink alias resolve to the same queue key and rename entry', async () => {
    const module = await atomicModule()
    const target = join(testDir, 'target.txt')
    const alias = join(testDir, 'alias.txt')
    writeFileSync(target, 'A')
    symlinkSync(target, alias)

    const direct = await module.resolveAtomicWriteDestination(target, [testDir])
    const throughAlias = await module.resolveAtomicWriteDestination(alias, [testDir])

    expect(throughAlias).toBe(direct)
  })

  test('uses the resolved physical target as both queue key and rename destination for a final symlink', async () => {
    const module = await atomicModule()
    const target = join(testDir, 'target.txt')
    const alias = join(testDir, 'alias.txt')
    writeFileSync(target, 'A')
    symlinkSync(target, alias)
    const base = module.createNodeAtomicWriteOperations()
    const queueKeys: string[] = []
    const renameDestinations: string[] = []

    await writeAtomically(request(alias, Buffer.from('B')), {
      withPathMutationQueue: async (key, work) => {
        queueKeys.push(key)
        return base.withPathMutationQueue(key, work)
      },
      rename: async (from, to) => {
        renameDestinations.push(to)
        await base.rename(from, to)
      },
    })

    const physicalTarget = join(await realpath(dirname(target)), basename(target))
    mutationBoundary('alias-canonical-queue-key', () => expect(queueKeys).toEqual([physicalTarget]))
    expect(renameDestinations).toEqual([physicalTarget])
    expect(lstatSync(alias).isSymbolicLink()).toBe(true)
    expectBytes(target, Buffer.from('B'))
  })

  test('registers every direct-path write exactly once on its resolved destination queue', async () => {
    const module = await atomicModule()
    const path = join(testDir, 'direct.txt')
    const resolved = await module.resolveAtomicWriteDestination(path, [testDir])
    const base = module.createNodeAtomicWriteOperations()
    const queueKeys: string[] = []

    await writeAtomically(request(path, Buffer.from('content')), {
      withPathMutationQueue: async (key, work) => {
        queueKeys.push(key)
        return base.withPathMutationQueue(key, work)
      },
    })

    mutationBoundary('direct-write-queue-registration', () => expect(queueKeys).toEqual([resolved]))
    expectBytes(path, Buffer.from('content'))
  })

  test('rejects a dangling final symlink and preserves the symlink entry', async () => {
    const module = await atomicModule()
    const alias = join(testDir, 'dangling.txt')
    symlinkSync(join(testDir, 'missing-target.txt'), alias)

    await expectBoundedRejection(
      module.resolveAtomicWriteDestination(alias, [testDir]),
      /dangling.*symlink|symlink.*missing/i
    )
    expect(lstatSync(alias).isSymbolicLink()).toBe(true)
  })

  test.each([
    ['outside allowed roots', () => join(tmpdir(), 'outside-atomic.txt'), /allowed root|outside/i],
    ['directory destination', () => testDir, /regular file|directory|type/i],
  ])('rejects %s before queue registration', async (_name, pathFactory, category) => {
    const module = await atomicModule()
    await expectBoundedRejection(module.resolveAtomicWriteDestination(pathFactory(), [testDir]), category)
  })
  test.each(['resolver', 'initial read'] as const)('sanitizes raw %s failures before publication', async (boundary) => {
    const path = join(testDir, `boundary-${boundary}.txt`)
    const leaked = `SECRET-CANDIDATE ${path} ${'🙂'.repeat(600)}`

    const rejection = await captureRejection(
      withNodeOperations((base) =>
        writeAtomically(
          request(path, Buffer.from('SECRET-CANDIDATE')),
          boundary === 'resolver'
            ? {
                resolveDestination: async () => {
                  throw new Error(`Atomic write leaked ${leaked}`)
                },
              }
            : {
                resolveDestination: base.resolveDestination,
                readDestination: async () => {
                  throw new Error(`Edit conflict leaked ${leaked}`)
                },
              }
        )
      )
    )
    mutationBoundary(`branding-${boundary}`, () => {
      expect(rejection).toBeInstanceOf(Error)
      const message = (rejection as Error).message
      expect(message).not.toContain('SECRET-CANDIDATE')
      expect(message).not.toContain(path)
      expect(message).not.toContain('🙂')
    })
    expectBoundedError(rejection, /candidate was not published by this writer/i, ['SECRET-CANDIDATE', path, '🙂'])
  })
})

describe('sanitized filesystem diagnostics and stage ownership', () => {
  test.each([
    ['EACCES', 'permission-denied'],
    ['EROFS', 'read-only-filesystem'],
    ['ENOSPC', 'no-space'],
  ] as const)(
    'reports stable %s without leaking raw paths and never cleans an unowned stage',
    async (errno, filesystemClass) => {
      const destination = join(testDir, 'protected.txt')
      writeFileSync(destination, 'ORIGINAL')
      let cleanupCalls = 0
      const raw = Object.assign(new Error(`SECRET ${destination}`), { code: errno, path: destination })
      const error = await expectBoundedRejection(
        writeAtomically(request(destination, Buffer.from('RESULT')), {
          openStage: async () => {
            throw raw
          },
          removeOwnedStage: async () => {
            cleanupCalls += 1
          },
        }),
        new RegExp(errno),
        [destination, 'SECRET', 'RESULT']
      )
      const module = await atomicModule()
      expect(module.getAtomicWriteFailureDetails(error)).toEqual({ errno, filesystemClass })
      expect(cleanupCalls).toBe(0)
      expect(readFileSync(destination, 'utf8')).toBe('ORIGINAL')
    }
  )
})

describe('stage and publication protocol', () => {
  test('orders handle verification, mode, sync, final observation, publication, readbacks, and close', async () => {
    const path = join(testDir, 'target.txt')
    const original = Buffer.from('snapshot-A')
    const content = Buffer.from('candidate-bytes')
    writeFileSync(path, original, { mode: 0o644 })
    const module = await atomicModule()
    const base = module.createNodeAtomicWriteOperations()
    const events: string[] = []

    const result = await writeAtomically(
      request(path, content, { mode: 0o640, expectedOriginal: identity(original) }),
      {
        readDestination: async (destination) => {
          events.push('destination-read')
          return base.readDestination(destination)
        },
        openStage: async (stagePath, flags, mode) => {
          events.push(`open:${flags}:${mode.toString(8)}:${dirname(stagePath) === dirname(path)}`)
          expect(basename(stagePath)).toMatch(/^\.target\.txt\..+\.tmp$/)
          const handle = await base.openStage(stagePath, flags, mode)
          return {
            writeAll: async (bytes) => {
              events.push('write')
              await handle.writeAll(bytes)
            },
            readAt: async (offset, length) => {
              events.push(`handle-read:${offset}:${length}`)
              return handle.readAt(offset, length)
            },
            chmod: async (finalMode) => {
              events.push(`chmod:${finalMode.toString(8)}`)
              await handle.chmod(finalMode)
            },
            sync: async () => {
              events.push('sync')
              await handle.sync()
            },
            stat: async () => {
              events.push('handle-stat')
              return handle.stat()
            },
            close: async () => {
              events.push('close')
              await handle.close()
            },
          }
        },
        rename: async (from, to) => {
          events.push('rename')
          await base.rename(from, to)
        },
        statPath: async (statPath) => {
          events.push('path-stat')
          return base.statPath(statPath)
        },
        readPath: async (readPath) => {
          events.push('path-read')
          return base.readPath(readPath)
        },
      }
    )

    const open = events.indexOf('open:wx+:600:true')
    const write = events.indexOf('write')
    const handleReads = events
      .map((event, index) => (event.startsWith('handle-read:') ? index : -1))
      .filter((index) => index >= 0)
    const chmod = events.indexOf('chmod:640')
    const sync = events.indexOf('sync')
    const destinationReads = events
      .map((event, index) => (event === 'destination-read' ? index : -1))
      .filter((index) => index >= 0)
    const rename = events.indexOf('rename')
    const handleStat = events.indexOf('handle-stat')
    const pathStat = events.indexOf('path-stat')
    const pathRead = events.indexOf('path-read')
    const close = events.indexOf('close')

    expect(result).toEqual({ bytesWritten: content.byteLength, sha256: sha256(content) })
    const preChmodReads = handleReads.filter((index) => index > write && index < chmod)
    const postRenameReads = handleReads.filter((index) => index > rename && index < handleStat)

    expect(destinationReads).toHaveLength(2)
    expect(handleReads.length).toBeGreaterThanOrEqual(2)
    expect(destinationReads[0]).toBeLessThan(open)
    expect(open).toBeLessThan(write)
    mutationBoundary('verify-before-chmod-order', () => {
      expect(preChmodReads.length).toBeGreaterThanOrEqual(1)
      expect(handleReads[0]).toBeLessThan(chmod)
    })
    expect(chmod).toBeLessThan(sync)
    expect(sync).toBeLessThan(destinationReads[1])
    expect(destinationReads[1]).toBeLessThan(rename)
    expect(postRenameReads.length).toBeGreaterThanOrEqual(1)
    expect(handleReads.every((index) => preChmodReads.includes(index) || postRenameReads.includes(index))).toBe(true)
    expect(handleReads.at(-1)!).toBeLessThan(handleStat)
    expect(handleStat).toBeLessThan(pathStat)
    expect(pathStat).toBeLessThan(pathRead)
    expect(pathRead).toBeLessThan(close)
    expect(statSync(path).mode & 0o777).toBe(0o640)
    expectBytes(path, content)
  })

  test('lands explicit, preserved, and new-file modes exactly under a restrictive subprocess umask', async () => {
    await atomicModule()
    const modulePath = join(import.meta.dir, 'atomic-write.ts')
    const probeDir = join(testDir, 'umask-probe')
    const script = `
      import { mkdir, writeFile, chmod, stat } from 'fs/promises'
      import { join } from 'path'
      import { atomicVerifiedWrite } from ${JSON.stringify(modulePath)}
      const root = process.env.PROBE_ROOT
      process.umask(0o077)
      await mkdir(root, { recursive: true })
      const explicit = join(root, 'explicit.txt')
      const preserved = join(root, 'preserved.txt')
      const fresh = join(root, 'fresh.txt')
      await writeFile(preserved, 'old')
      await chmod(preserved, 0o624)
      await atomicVerifiedWrite({ path: explicit, allowedRoots: [root], content: Buffer.from('x'), mode: 0o640 })
      await atomicVerifiedWrite({ path: preserved, allowedRoots: [root], content: Buffer.from('y') })
      await atomicVerifiedWrite({ path: fresh, allowedRoots: [root], content: Buffer.from('z') })
      console.log(JSON.stringify([
        (await stat(explicit)).mode & 0o777,
        (await stat(preserved)).mode & 0o777,
        (await stat(fresh)).mode & 0o777,
      ]))
    `
    const child = Bun.spawn([process.execPath, '-e', script], {
      env: { ...process.env, PROBE_ROOT: probeDir },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])

    expect(exitCode, stderr).toBe(0)
    const modes = JSON.parse(stdout.trim()) as number[]
    mutationBoundary('chmod-explicit-preserved-modes', () => expect(modes.slice(0, 2)).toEqual([0o640, 0o624]))
    mutationBoundary('umask-default-mode', () => expect(modes[2]).toBe(0o600))
  })

  test.each([
    ['dropped suffix', (value: Buffer) => value.subarray(0, -3)],
    ['dropped middle', (value: Buffer) => Buffer.concat([value.subarray(0, 4), value.subarray(9)])],
    ['LF converted to CRLF', (value: Buffer) => Buffer.from(value.toString().replaceAll('\n', '\r\n'))],
  ] as const)('rejects %s during handle readback before rename', async (_name, corrupt) => {
    const path = join(testDir, 'target.txt')
    const original = Buffer.from('ORIGINAL-SENTINEL')
    const content = Buffer.from('line-one\nMIDDLE-PAYLOAD\nline-three\n')
    writeFileSync(path, original)
    let renamed = false

    const rejection = await captureRejection(
      withNodeOperations(async (base) =>
        writeAtomically(request(path, content, { expectedOriginal: identity(original) }), {
          openStage: async (stagePath, flags, mode) => {
            const handle = await base.openStage(stagePath, flags, mode)
            return { ...handle, readAt: async (offset, length) => corrupt(await handle.readAt(offset, length)) }
          },
          rename: async (from, to) => {
            renamed = true
            await base.rename(from, to)
          },
        })
      )
    )

    mutationBoundary('stage-readback-prevents-rename', () => expect(renamed).toBe(false))
    expectBoundedError(rejection, /stage|pre-publication|candidate was not published|integrity/i, [
      'ORIGINAL-SENTINEL',
      'MIDDLE-PAYLOAD',
    ])
    expectBytes(path, original)
  })

  test('reports post-rename mismatch as candidate may have been published', async () => {
    const path = join(testDir, 'target.txt')
    const original = Buffer.from('snapshot-A')
    const content = Buffer.from('candidate-B')
    writeFileSync(path, original)
    let published = false

    await asyncMutationBoundary('published-pathname-readback', () =>
      expectBoundedRejection(
        withNodeOperations((base) =>
          writeAtomically(request(path, content, { expectedOriginal: identity(original) }), {
            rename: async (from, to) => {
              await base.rename(from, to)
              published = true
            },
            readPath: async (readPath) =>
              published && readPath === path ? Buffer.from('post-rename-C') : base.readPath(readPath),
          })
        ),
        /candidate may have been published.*success was not reported/i,
        ['snapshot-A', 'candidate-B', 'post-rename-C']
      )
    )

    expect(published).toBe(true)
  })

  test('rejects post-rename handle readback no-progress with published-phase wording', async () => {
    const path = join(testDir, 'target.txt')
    const content = Buffer.from('candidate-bytes')
    let published = false

    await asyncMutationBoundary('published-handle-readback', () =>
      expectBoundedRejection(
        withNodeOperations((base) =>
          writeAtomically(request(path, content), {
            openStage: async (stagePath, flags, mode) => {
              const handle = await base.openStage(stagePath, flags, mode)
              return {
                ...handle,
                readAt: (offset, length) =>
                  published ? Promise.resolve(Buffer.alloc(0)) : handle.readAt(offset, length),
              }
            },
            rename: async (from, to) => {
              await base.rename(from, to)
              published = true
            },
          })
        ),
        /candidate may have been published.*success was not reported/i
      )
    )

    expect(published).toBe(true)
  })

  test('rejects a post-rename handle-to-path inode mismatch with published-phase wording', async () => {
    const path = join(testDir, 'target.txt')
    const content = Buffer.from('candidate-bytes')
    let published = false

    await asyncMutationBoundary('published-inode-identity', () =>
      expectBoundedRejection(
        withNodeOperations((base) =>
          writeAtomically(request(path, content), {
            rename: async (from, to) => {
              await base.rename(from, to)
              published = true
            },
            statPath: async (statPath) => {
              const actual = await base.statPath(statPath)
              return published
                ? { ...actual, ino: typeof actual.ino === 'bigint' ? actual.ino + 1n : actual.ino + 1 }
                : actual
            },
          })
        ),
        /candidate may have been published.*success was not reported/i
      )
    )

    expect(published).toBe(true)
  })
})

describe('cooperating structured writers', () => {
  test('serializes same-snapshot commits until cleanup and lets exactly one publish', async () => {
    const module = await atomicModule()
    const path = join(testDir, 'target.txt')
    const original = Buffer.from('snapshot-A')
    const winner = Buffer.from('winner-B')
    const stale = Buffer.from('stale-C')
    writeFileSync(path, original)
    const base = module.createNodeAtomicWriteOperations()
    const firstAtRename = deferred()
    const releaseFirst = deferred()
    let secondEntered = false
    let renameCount = 0

    const first = writeAtomically(request(path, winner, { expectedOriginal: identity(original) }), {
      rename: async (from, to) => {
        renameCount += 1
        firstAtRename.resolve()
        await releaseFirst.promise
        await base.rename(from, to)
      },
    })
    await firstAtRename.promise
    const second = writeAtomically(request(path, stale, { expectedOriginal: identity(original) }), {
      readDestination: async (destination) => {
        secondEntered = true
        return base.readDestination(destination)
      },
      rename: async (from, to) => {
        renameCount += 1
        await base.rename(from, to)
      },
    })
    await Promise.resolve()
    let exclusionError: unknown
    try {
      expect(secondEntered).toBe(false)
    } catch (error) {
      exclusionError = error
    } finally {
      releaseFirst.resolve()
    }

    await Promise.allSettled([first, second])
    if (exclusionError) throw exclusionError
    await first
    await expectBoundedRejection(second, /conflict|candidate was not published/i, ['snapshot-A', 'stale-C'])
    expect(renameCount).toBe(1)
    expectBytes(path, winner)
  })

  test('holds the same-key queue until owned-stage cleanup settles while different keys remain parallel', async () => {
    const module = await atomicModule()
    const firstPath = join(testDir, 'first.txt')
    const otherPath = join(testDir, 'other.txt')
    const cleanupStarted = deferred()
    const releaseCleanup = deferred()
    const base = module.createNodeAtomicWriteOperations()
    let sameKeyEntered = false
    let otherKeyEntered = false

    const first = writeAtomically(request(firstPath, Buffer.from('first')), {
      removeOwnedStage: async (stage) => {
        cleanupStarted.resolve()
        await releaseCleanup.promise
        await base.removeOwnedStage(stage)
      },
    })
    await cleanupStarted.promise
    const sameKey = writeAtomically(request(firstPath, Buffer.from('second')), {
      readDestination: async (destination) => {
        sameKeyEntered = true
        return base.readDestination(destination)
      },
    })
    const otherKey = writeAtomically(request(otherPath, Buffer.from('parallel')), {
      openStage: async (...args) => {
        otherKeyEntered = true
        return base.openStage(...args)
      },
    })
    await otherKey
    expect(otherKeyEntered).toBe(true)
    expect(sameKeyEntered).toBe(false)
    releaseCleanup.resolve()
    await Promise.all([first, sameKey])
  })

  test('observes an external A-to-C change at the final in-queue check without renaming', async () => {
    const path = join(testDir, 'target.txt')
    const original = Buffer.from('snapshot-A')
    const external = Buffer.from('external-C')
    writeFileSync(path, original)
    let reads = 0
    let renamed = false

    await expectBoundedRejection(
      withNodeOperations((base) =>
        writeAtomically(request(path, Buffer.from('candidate-B'), { expectedOriginal: identity(original) }), {
          readDestination: async (destination) => {
            reads += 1
            if (reads === 2) writeFileSync(path, external)
            return base.readDestination(destination)
          },
          rename: async (from, to) => {
            renamed = true
            await base.rename(from, to)
          },
        })
      ),
      /candidate was not published/i,
      ['snapshot-A', 'candidate-B', 'external-C']
    )

    expect(reads).toBe(2)
    expect(renamed).toBe(false)
    expectBytes(path, external)
  })
})

describe('primary-first error handling', () => {
  test('flattens stage, close, and cleanup failures in sanitized primary-first order', async () => {
    const path = join(testDir, 'target.txt')
    const primary = new Error(`Atomic write leaked SECRET-CANDIDATE ${path}.uuid-stage`)
    const close = new Error(`Edit conflict leaked ${path}.uuid-stage`)
    const cleanup = new Error(`Atomic write leaked cleanup ${path}.uuid-stage`)

    const rejection = await captureRejection(
      withNodeOperations((base) =>
        writeAtomically(request(path, Buffer.from('SECRET-CANDIDATE')), {
          openStage: async (stagePath, flags, mode) => {
            const handle = await base.openStage(stagePath, flags, mode)
            return {
              ...handle,
              writeAll: async () => {
                throw primary
              },
              close: async () => {
                throw close
              },
            }
          },
          removeOwnedStage: async () => {
            throw cleanup
          },
        })
      )
    )

    mutationBoundary('stage-close-cleanup-aggregation', () => {
      expect(rejection).toBeInstanceOf(AggregateError)
      const errors = (rejection as AggregateError).errors as Error[]
      expect(errors).toHaveLength(3)
      expect(errors.map((component) => component.message)).toEqual([
        expect.stringMatching(/pre-publication operation failed/i),
        expect.stringMatching(/stage handle close failed/i),
        expect.stringMatching(/owned-stage cleanup failed/i),
      ])
      expect((rejection as AggregateError).cause).toBe(errors[0])
    })
    const error = expectBoundedError(rejection, /pre-publication operation failed.*candidate was not published/i, [
      'SECRET-CANDIDATE',
      path,
      'uuid-stage',
    ]) as AggregateError
    for (const component of error.errors as Error[]) {
      expect(Buffer.byteLength(component.message)).toBeLessThanOrEqual(512)
      expect(component.message).not.toContain(path)
      expect(component.message).not.toContain('SECRET-CANDIDATE')
    }
  })

  test('aggregates inner write primary before close failure', async () => {
    const path = join(testDir, 'target.txt')
    const primary = new Error(`Atomic write leaked inner candidate ${path}`)
    const close = new Error(`Edit conflict leaked inner stage ${path}`)

    const rejection = await captureRejection(
      withNodeOperations((base) =>
        writeAtomically(request(path, Buffer.from('candidate')), {
          openStage: async (stagePath, flags, mode) => {
            const handle = await base.openStage(stagePath, flags, mode)
            return {
              ...handle,
              writeAll: async () => {
                throw primary
              },
              close: async () => {
                throw close
              },
            }
          },
        })
      )
    )

    mutationBoundary('write-close-primary-aggregation', () => {
      expect(rejection).toBeInstanceOf(AggregateError)
      const errors = (rejection as AggregateError).errors as Error[]
      expect(errors).toHaveLength(2)
      expect(errors.map((component) => component.message)).toEqual([
        expect.stringMatching(/pre-publication operation failed/i),
        expect.stringMatching(/stage handle close failed/i),
      ])
      expect((rejection as AggregateError).cause).toBe(errors[0])
    })
    const error = expectBoundedError(
      rejection,
      /pre-publication operation failed.*candidate was not published/i
    ) as AggregateError
    for (const component of error.errors as Error[]) {
      expect(Buffer.byteLength(component.message)).toBeLessThanOrEqual(512)
      expect(component.message).not.toContain(path)
    }
  })

  test.each(['close', 'cleanup'] as const)('reports sole post-publication %s failure truthfully', async (fault) => {
    const path = join(testDir, `target-${fault}.txt`)

    await expectBoundedRejection(
      withNodeOperations((base) =>
        writeAtomically(
          request(path, Buffer.from('candidate')),
          fault === 'close'
            ? {
                openStage: async (stagePath, flags, mode) => {
                  const handle = await base.openStage(stagePath, flags, mode)
                  return {
                    ...handle,
                    close: async () => {
                      throw new Error(`raw close ${stagePath}`)
                    },
                  }
                },
              }
            : {
                removeOwnedStage: async (stagePath) => {
                  throw new Error(`raw cleanup ${stagePath}`)
                },
              }
        )
      ),
      /candidate may have been published.*success was not reported/i,
      [path, '.tmp']
    )
  })

  test('rename failure uses ambiguous-publication phase wording', async () => {
    const path = join(testDir, 'target.txt')
    await asyncMutationBoundary('ambiguous-rename-branding', () =>
      expectBoundedRejection(
        writeAtomically(request(path, Buffer.from('candidate')), {
          rename: async () => {
            throw new Error('injected rename failure')
          },
        }),
        /publication outcome follows filesystem rename semantics.*success was not reported/i
      )
    )
  })
})

describe('stable atomic failure classification', () => {
  test('classifies the branded primary failure without parsing public messages', async () => {
    const module = await atomicModule()

    const conflictPath = join(testDir, 'classifier-conflict.txt')
    writeFileSync(conflictPath, 'current')
    const conflict = await captureRejection(
      writeAtomically(
        request(conflictPath, Buffer.from('candidate'), { expectedOriginal: identity(Buffer.from('stale')) })
      )
    )
    const pre = await captureRejection(
      writeAtomically(
        request(join(testDir, 'classifier-pre.txt'), Buffer.from('candidate'), {
          expectedResult: identity(Buffer.from('different')),
        })
      )
    )
    const postPath = join(testDir, 'classifier-post.txt')
    const post = await captureRejection(
      writeAtomically(request(postPath, Buffer.from('candidate')), {
        readPath: async () => Buffer.from('corrupt-after-rename'),
      })
    )
    const rename = await captureRejection(
      writeAtomically(request(join(testDir, 'classifier-rename.txt'), Buffer.from('candidate')), {
        rename: async () => {
          throw new Error('raw rename error must not escape')
        },
      })
    )

    mutationBoundary('classifier-conflict-code', () => {
      expect(module.getAtomicWriteFailureCode(conflict)).toBe('edit-conflict')
    })
    mutationBoundary('classifier-nested-primary', () => {
      expect(module.getAtomicWriteFailureCode(new AggregateError([new AggregateError([conflict, pre])]))).toBe(
        'edit-conflict'
      )
    })
    mutationBoundary('classifier-generic-pre-code', () => {
      expect(module.getAtomicWriteFailureCode(pre)).toBe('pre-publication')
    })
    mutationBoundary('classifier-post-code', () => {
      expect(module.getAtomicWriteFailureCode(post)).toBe('post-publication')
    })
    mutationBoundary('classifier-rename-code', () => {
      expect(module.getAtomicWriteFailureCode(rename)).toBe('rename-outcome-unknown')
    })
    mutationBoundary('classifier-unbranded-spoof', () => {
      expect(module.getAtomicWriteFailureCode(new Error('Edit conflict spoof'))).toBe(undefined)
    })
  })
})
