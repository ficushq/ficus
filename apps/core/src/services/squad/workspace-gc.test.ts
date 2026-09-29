import { afterEach, describe, expect, it } from 'bun:test'
import { lstat, mkdir, mkdtemp, open, readFile, readdir, rm, rmdir, symlink, writeFile } from 'fs/promises'
import { join, relative } from 'path'
import { tmpdir } from 'os'
import { createBoundedRendezvous } from './bounded-rendezvous.test-helper'
import { reconcileWorkspaceStubs } from './workspace-gc'

const roots: string[] = []

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'ficus-workspace-gc-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const DIAGNOSTIC_CONTENT_LIMIT = 4096

interface OwnedTreeEntry {
  path: string
  type: 'directory' | 'file' | 'symlink' | 'special' | 'error'
  contents?: string
  error?: string
}

async function captureOwnedTree(root: string): Promise<OwnedTreeEntry[]> {
  const snapshot: OwnedTreeEntry[] = []

  async function visit(path: string): Promise<void> {
    const ownedPath = relative(root, path) || '.'
    let stat
    try {
      stat = await lstat(path)
    } catch (error) {
      snapshot.push({ path: ownedPath, type: 'error', error: String(error) })
      return
    }

    if (stat.isSymbolicLink()) {
      snapshot.push({ path: ownedPath, type: 'symlink' })
      return
    }
    if (stat.isDirectory()) {
      snapshot.push({ path: ownedPath, type: 'directory' })
      try {
        for (const name of (await readdir(path)).sort()) await visit(join(path, name))
      } catch (error) {
        snapshot.push({ path: ownedPath, type: 'error', error: String(error) })
      }
      return
    }
    if (stat.isFile()) {
      try {
        const handle = await open(path, 'r')
        try {
          const buffer = Buffer.alloc(DIAGNOSTIC_CONTENT_LIMIT)
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
          snapshot.push({ path: ownedPath, type: 'file', contents: buffer.subarray(0, bytesRead).toString('utf8') })
        } finally {
          await handle.close()
        }
      } catch (error) {
        snapshot.push({ path: ownedPath, type: 'error', error: String(error) })
      }
      return
    }
    snapshot.push({ path: ownedPath, type: 'special' })
  }

  await visit(root)
  return snapshot
}

function deps(root: string, knownSquadIds = new Set<string>(), status = 'not_found') {
  return {
    getRoot: () => root,
    listSquadIds: async () => new Set(knownSquadIds),
    getSandboxStatus: async () => status,
  }
}

function makeRendezvousResources() {
  const callbacks = new Map<number, () => void>()
  const controller = new AbortController()
  const signal = controller.signal
  const addEventListener = signal.addEventListener.bind(signal)
  const removeEventListener = signal.removeEventListener.bind(signal)
  let nextId = 0
  let listeners = 0
  signal.addEventListener = ((
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions
  ) => {
    listeners++
    addEventListener(type, listener, options)
  }) as typeof signal.addEventListener
  signal.removeEventListener = ((
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | EventListenerOptions
  ) => {
    listeners--
    removeEventListener(type, listener, options)
  }) as typeof signal.removeEventListener

  return {
    controller,
    signal,
    clock: {
      setTimeout(callback: () => void) {
        const id = ++nextId
        callbacks.set(id, callback)
        return id
      },
      clearTimeout(id: unknown) {
        callbacks.delete(id as number)
      },
    },
    get activeTimers() {
      return callbacks.size
    },
    get activeListeners() {
      return listeners
    },
    fireTimer() {
      expect(callbacks.size).toBe(1)
      const callback = callbacks.values().next().value
      expect(callback).toBeDefined()
      callback!()
    },
  }
}

describe('bounded race rendezvous', () => {
  it('releases both participants and clears the timer when both arrive', async () => {
    const resources = makeRendezvousResources()
    const rendezvous = createBoundedRendezvous(
      ['first', 'second'],
      'beforeRemove',
      50,
      resources.signal,
      resources.clock
    )

    await Promise.all([rendezvous.arrive('first'), rendezvous.arrive('second')])

    expect(resources.activeTimers).toBe(0)
    expect(resources.activeListeners).toBe(0)
  })

  it.each([
    ['first', 'second'],
    ['second', 'first'],
  ] as const)('reports when only %s arrives and releases it', async (arrived, missing) => {
    const resources = makeRendezvousResources()
    const rendezvous = createBoundedRendezvous(
      ['first', 'second'],
      'beforeRemove',
      10,
      resources.signal,
      resources.clock
    )
    const waiting = rendezvous.arrive(arrived)

    resources.fireTimer()

    await expect(waiting).rejects.toThrow(
      `Rendezvous timed out in phase "beforeRemove"; missing: ${missing}; arrived: ${arrived}`
    )
    expect(resources.activeTimers).toBe(0)
    expect(resources.activeListeners).toBe(0)
  })

  it('releases a waiting participant and clears its timer when its peer throws', async () => {
    const resources = makeRendezvousResources()
    const rendezvous = createBoundedRendezvous(
      ['first', 'second'],
      'beforeRemove',
      50,
      resources.signal,
      resources.clock
    )
    const waiting = rendezvous.arrive('first')

    rendezvous.abort('second', new Error('classification failed'))

    await expect(waiting).rejects.toThrow('Rendezvous aborted in phase "beforeRemove" by second: classification failed')
    expect(resources.activeTimers).toBe(0)
    expect(resources.activeListeners).toBe(0)
  })

  it('releases every participant and removes cancellation resources', async () => {
    const resources = makeRendezvousResources()
    const rendezvous = createBoundedRendezvous(
      ['first', 'second'],
      'beforeRemove',
      50,
      resources.signal,
      resources.clock
    )
    const waiting = rendezvous.arrive('second')

    resources.controller.abort('test cancelled')

    await expect(waiting).rejects.toThrow(
      'Rendezvous cancelled in phase "beforeRemove"; missing: first; arrived: second; reason: test cancelled'
    )
    expect(resources.activeTimers).toBe(0)
    expect(resources.activeListeners).toBe(0)
  })

  it.each(['duplicate', 'unexpected'] as const)('releases a waiting peer after invalid %s arrival', async (kind) => {
    const resources = makeRendezvousResources()
    const rendezvous = createBoundedRendezvous(
      ['first', 'second'],
      'beforeRemove',
      50,
      resources.signal,
      resources.clock
    )
    const waiting = rendezvous.arrive('first')

    const invalid = kind === 'duplicate' ? rendezvous.arrive('first') : rendezvous.arrive('intruder' as 'first')

    await expect(invalid).rejects.toThrow(`${kind === 'duplicate' ? 'Duplicate' : 'Unexpected'} rendezvous participant`)
    await expect(waiting).rejects.toThrow(`${kind === 'duplicate' ? 'Duplicate' : 'Unexpected'} rendezvous participant`)
    expect(resources.activeTimers).toBe(0)
    expect(resources.activeListeners).toBe(0)
  })

  it('rejects an empty participant configuration', () => {
    expect(() => createBoundedRendezvous([] as string[], 'beforeRemove', 50)).toThrow(
      'Rendezvous participants must be non-empty and unique'
    )
  })

  it('rejects a duplicate participant configuration', () => {
    expect(() => createBoundedRendezvous(['first', 'first'], 'beforeRemove', 50)).toThrow(
      'Rendezvous participants must be non-empty and unique'
    )
  })

  it('supports repeated concurrent runs without retaining timers or waiters', async () => {
    const resources = makeRendezvousResources()
    for (let run = 0; run < 50; run++) {
      const rendezvous = createBoundedRendezvous(
        ['first', 'second'],
        `beforeRemove:${run}`,
        50,
        resources.signal,
        resources.clock
      )
      await Promise.all([rendezvous.arrive('first'), rendezvous.arrive('second')])
      expect(rendezvous.pending).toBe(false)
      expect(resources.activeTimers).toBe(0)
      expect(resources.activeListeners).toBe(0)
    }
  })
})

describe('reconcileWorkspaceStubs', () => {
  it('dry-runs only immediate empty orphan UUID directories without mutating', async () => {
    const root = await makeRoot()
    const eligible = crypto.randomUUID()
    const known = crypto.randomUUID()
    const nonEmpty = crypto.randomUUID()
    const nested = crypto.randomUUID()
    const linked = crypto.randomUUID()
    const target = await makeRoot()
    await mkdir(join(root, eligible))
    await mkdir(join(root, known))
    await mkdir(join(root, nonEmpty))
    await writeFile(join(root, nonEmpty, 'repo.txt'), 'keep')
    await mkdir(join(root, nested, 'child'), { recursive: true })
    await mkdir(join(root, 'not-a-uuid'))
    await symlink(target, join(root, linked))

    const result = await reconcileWorkspaceStubs({}, deps(root, new Set([known])))

    expect(result.mode).toBe('dry-run')
    expect(result.eligible).toBe(1)
    expect(result.removed).toBe(0)
    expect(result.protected.extant_squad).toBe(1)
    expect(result.protected.non_empty).toBe(2)
    expect(result.protected.symlink).toBe(1)
    expect(result.skipped.invalid_name).toBe(1)
    expect(await readdir(root)).toContain(eligible)
  })

  it('apply removes only empty absent orphans and is restart-idempotent', async () => {
    const root = await makeRoot()
    const first = crypto.randomUUID()
    const second = crypto.randomUUID()
    await mkdir(join(root, first))
    await mkdir(join(root, second))

    const applied = await reconcileWorkspaceStubs({ apply: true }, deps(root))
    const repeated = await reconcileWorkspaceStubs({ apply: true }, deps(root))

    expect(applied.removed).toBe(2)
    expect(repeated.removed).toBe(0)
  })

  it('protects live and unknown sandbox states', async () => {
    const root = await makeRoot()
    const live = crypto.randomUUID()
    const unknown = crypto.randomUUID()
    await mkdir(join(root, live))
    await mkdir(join(root, unknown))
    const statuses = new Map([
      [`squad_${live}`, 'running'],
      [`squad_${unknown}`, 'unknown'],
    ])

    const result = await reconcileWorkspaceStubs(
      { apply: true },
      {
        ...deps(root),
        getSandboxStatus: async (id: string) => statuses.get(id) ?? 'not_found',
      }
    )

    expect(result.removed).toBe(0)
    expect(result.protected.sandbox_present).toBe(2)
  })

  it('revalidates emptiness after classification and before removal', async () => {
    const root = await makeRoot()
    const neighbor = crypto.randomUUID()
    const id = crypto.randomUUID()
    const path = join(root, id)
    const racedFile = join(path, 'raced.txt')
    await mkdir(path)
    await mkdir(join(root, neighbor))
    await writeFile(join(root, neighbor, 'keep.txt'), 'neighbor')
    let premiseObserved = false
    let candidateReads = 0

    const result = await reconcileWorkspaceStubs(
      { apply: true },
      {
        ...deps(root),
        beforeRemove: async (candidate) => {
          expect(candidate).toBe(path)
          expect(candidateReads).toBe(1)
          expect(await readdir(candidate)).toEqual([])
          await writeFile(racedFile, 'keep')
          premiseObserved = true
        },
        fs: {
          lstat,
          readdir: (async (candidate) => {
            if (candidate.toString() === path) candidateReads++
            return readdir(candidate)
          }) as typeof readdir,
          rmdir: async () => {
            throw new Error('rmdir must not run for a changed candidate')
          },
        },
      }
    )

    expect(premiseObserved).toBe(true)
    expect(candidateReads).toBe(2)
    expect(result.removed).toBe(0)
    expect(result.protected.changed).toBe(1)
    expect(result.errors.UNKNOWN).toBeUndefined()
    expect(await readFile(racedFile, 'utf8')).toBe('keep')
    expect(await readFile(join(root, neighbor, 'keep.txt'), 'utf8')).toBe('neighbor')
  })

  it('revalidates the candidate type after classification without following a replacement symlink', async () => {
    const root = await makeRoot()
    const outside = await makeRoot()
    const id = crypto.randomUUID()
    const path = join(root, id)
    const sentinel = join(outside, 'keep.txt')
    await mkdir(path)
    await writeFile(sentinel, 'outside')
    let premiseObserved = false
    let candidateStats = 0
    let candidateReads = 0

    const result = await reconcileWorkspaceStubs(
      { apply: true },
      {
        ...deps(root),
        beforeRemove: async (candidate) => {
          expect(candidate).toBe(path)
          expect(candidateStats).toBe(1)
          expect(candidateReads).toBe(1)
          await rmdir(path)
          await symlink(outside, path)
          premiseObserved = (await lstat(path)).isSymbolicLink()
        },
        fs: {
          lstat: (async (candidate) => {
            if (candidate.toString() === path) candidateStats++
            return lstat(candidate)
          }) as typeof lstat,
          readdir: (async (candidate) => {
            if (candidate.toString() === path) candidateReads++
            return readdir(candidate)
          }) as typeof readdir,
          rmdir: async () => {
            throw new Error('rmdir must not run for a changed candidate')
          },
        },
      }
    )

    expect(premiseObserved).toBe(true)
    expect(candidateStats).toBe(2)
    expect(candidateReads).toBe(1)
    expect(result.removed).toBe(0)
    expect(result.protected.changed).toBe(1)
    expect((await lstat(path)).isSymbolicLink()).toBe(true)
    expect(await readFile(sentinel, 'utf8')).toBe('outside')
  })

  it('revalidates active sandbox state after classification', async () => {
    const root = await makeRoot()
    const id = crypto.randomUUID()
    const path = join(root, id)
    await mkdir(path)
    let status = 'not_found'
    let premiseObserved = false
    let statusLookups = 0

    const result = await reconcileWorkspaceStubs(
      { apply: true },
      {
        ...deps(root),
        getSandboxStatus: async () => {
          statusLookups++
          return status
        },
        beforeRemove: async (candidate) => {
          expect(candidate).toBe(path)
          expect(statusLookups).toBe(1)
          status = 'running'
          premiseObserved = true
        },
      }
    )

    expect(premiseObserved).toBe(true)
    expect(statusLookups).toBe(2)
    expect(result.removed).toBe(0)
    expect(result.protected.sandbox_present).toBe(1)
    expect(await readdir(path)).toEqual([])
  })

  it('aborts before mutation when the squad snapshot fails', async () => {
    const root = await makeRoot()
    const id = crypto.randomUUID()
    await mkdir(join(root, id))

    await expect(
      reconcileWorkspaceStubs(
        { apply: true },
        {
          ...deps(root),
          listSquadIds: async () => {
            throw new Error('database unavailable')
          },
        }
      )
    ).rejects.toThrow('database unavailable')
    expect(await readdir(root)).toContain(id)
  })

  it('protects UUID-named regular files', async () => {
    const root = await makeRoot()
    const id = crypto.randomUUID()
    await writeFile(join(root, id), 'keep')

    const result = await reconcileWorkspaceStubs({ apply: true }, deps(root))

    expect(result.protected.special_file).toBe(1)
    expect(await readFile(join(root, id), 'utf8')).toBe('keep')
  })

  it('protects candidates when authoritative runtime status throws', async () => {
    const root = await makeRoot()
    const id = crypto.randomUUID()
    await mkdir(join(root, id))

    const result = await reconcileWorkspaceStubs(
      { apply: true },
      {
        ...deps(root),
        getSandboxStatus: async () => {
          throw new Error('runtime unavailable')
        },
      }
    )

    expect(result.protected.sandbox_status_error).toBe(1)
    expect(await readdir(root)).toContain(id)
  })

  it.each(['ENOENT', 'ENOTEMPTY', 'ENOTDIR', 'ELOOP'])(
    'classifies rmdir %s as a non-destructive changed outcome and continues',
    async (code) => {
      const root = await makeRoot()
      const ids = [crypto.randomUUID(), crypto.randomUUID()].sort()
      await Promise.all(ids.map((id) => mkdir(join(root, id))))

      const result = await reconcileWorkspaceStubs(
        { apply: true },
        {
          ...deps(root),
          fs: {
            lstat,
            readdir,
            rmdir: async (path) => {
              if (path.toString().endsWith(ids[0])) throw Object.assign(new Error(code), { code })
              return rmdir(path)
            },
          },
        }
      )

      expect(result.protected.changed).toBe(1)
      expect(result.removed).toBe(1)
      expect(await readdir(root)).toEqual([ids[0]])
    }
  )

  it('reports permission errors and continues the batch', async () => {
    const root = await makeRoot()
    const ids = [crypto.randomUUID(), crypto.randomUUID()].sort()
    await Promise.all(ids.map((id) => mkdir(join(root, id))))

    const result = await reconcileWorkspaceStubs(
      { apply: true },
      {
        ...deps(root),
        fs: {
          lstat,
          readdir,
          rmdir: async (path) => {
            if (path.toString().endsWith(ids[0])) {
              throw Object.assign(new Error('denied'), { code: 'EACCES' })
            }
            return rmdir(path)
          },
        },
      }
    )

    expect(result.errors.EACCES).toBe(1)
    expect(result.removed).toBe(1)
    expect(await readdir(root)).toEqual([ids[0]])
  })

  it('captures owned diagnostics without following symlink targets', async () => {
    const root = await makeRoot()
    const target = await makeRoot()
    await mkdir(join(root, 'owned'))
    const oversizedContents = `${'x'.repeat(DIAGNOSTIC_CONTENT_LIMIT)}outside diagnostic cap`
    await writeFile(join(root, 'owned', 'state.txt'), oversizedContents)
    await writeFile(join(target, 'secret.txt'), 'outside state')
    await symlink(target, join(root, 'linked-neighbor'))

    const snapshot = await captureOwnedTree(root)

    expect(snapshot).toContainEqual({
      path: 'owned/state.txt',
      type: 'file',
      contents: 'x'.repeat(DIAGNOSTIC_CONTENT_LIMIT),
    })
    expect(JSON.stringify(snapshot)).not.toContain('outside diagnostic cap')
    expect(snapshot).toContainEqual({ path: 'linked-neighbor', type: 'symlink' })
    expect(snapshot.some((entry) => entry.path.includes('secret.txt'))).toBe(false)
    expect(JSON.stringify(snapshot)).not.toContain('outside state')
  })

  it.each(['forward', 'reverse'] as const)(
    'isolates concurrent and rerun rmdir boundaries from %s cleanup offenders',
    async (ordering) => {
      const invocationRoot = await mkdtemp(join(tmpdir(), `ficus-workspace-gc-boundary-${crypto.randomUUID()}-`))
      const root = join(invocationRoot, 'workspaces', 'squads')
      const excludedNeighbor = join(invocationRoot, 'excluded-neighbor')
      const outsideSentinel = join(excludedNeighbor, 'keep.txt')
      const lowId = '00000000-0000-4000-8000-000000000001'
      const highId = 'ffffffff-ffff-4fff-bfff-ffffffffffff'
      const removableId = ordering === 'forward' ? lowId : highId
      const nonEmptyId = ordering === 'forward' ? highId : lowId
      const sandboxId = crypto.randomUUID()
      const symlinkId = crypto.randomUUID()
      const removablePath = join(root, removableId)
      const nonEmptyPath = join(root, nonEmptyId)
      const sandboxPath = join(root, sandboxId)
      const symlinkPath = join(root, symlinkId)
      const cwd = process.cwd()
      const arrivals: string[] = []
      let winnerTaken = false

      try {
        await mkdir(removablePath, { recursive: true })
        await mkdir(nonEmptyPath)
        await writeFile(join(nonEmptyPath, 'active.txt'), 'keep')
        await mkdir(sandboxPath)
        await mkdir(excludedNeighbor)
        await writeFile(outsideSentinel, 'outside')
        await symlink(excludedNeighbor, symlinkPath)

        // Prove the fixture reaches every safety branch before reconciling.
        expect((await lstat(root)).isDirectory()).toBe(true)
        expect(await readdir(removablePath)).toEqual([])
        expect(await readdir(nonEmptyPath)).toEqual(['active.txt'])
        expect(await readdir(sandboxPath)).toEqual([])
        expect((await lstat(symlinkPath)).isSymbolicLink()).toBe(true)
        expect(await readFile(outsideSentinel, 'utf8')).toBe('outside')

        // Bun's macOS rmdir may report success to both callers. This seam gives
        // the shared candidate faithful single-winner semantics while all
        // offender paths still use the real, non-recursive rmdir.
        const rendezvous = createBoundedRendezvous(['first', 'second'] as const, 'beforeRemove', 250)
        const beforeRemove = (participant: 'first' | 'second') => async (path: string) => {
          expect(path).toBe(removablePath)
          arrivals.push(participant)
          await rendezvous.arrive(participant)
        }
        const racingRmdir = (async (path: Parameters<typeof rmdir>[0]) => {
          if (path.toString() === removablePath) {
            if (winnerTaken) throw Object.assign(new Error('no such directory'), { code: 'ENOENT' })
            winnerTaken = true
          }
          return rmdir(path)
        }) as typeof rmdir
        const racingDeps = {
          ...deps(root),
          getSandboxStatus: async (id: string) => (id === `squad_${sandboxId}` ? 'running' : 'not_found'),
          fs: { lstat, readdir, rmdir: racingRmdir },
        }
        const runRacer = async (participant: 'first' | 'second') => {
          try {
            return await reconcileWorkspaceStubs(
              { apply: true },
              { ...racingDeps, beforeRemove: beforeRemove(participant) }
            )
          } catch (error) {
            rendezvous.abort(participant, error)
            throw error
          }
        }

        const concurrent = await Promise.all([runRacer('first'), runRacer('second')])
        expect(arrivals.sort()).toEqual(['first', 'second'])
        const rerun = await reconcileWorkspaceStubs({ apply: true }, racingDeps)
        const declined = concurrent.reduce(
          (total, result) => total + (result.protected.changed ?? 0) + (result.skipped.absent ?? 0),
          0
        )

        expect(concurrent.reduce((total, result) => total + result.removed, 0)).toBe(1)
        expect(declined).toBe(1)
        expect(rerun.removed).toBe(0)
        for (const reason of ['non_empty', 'sandbox_present', 'symlink']) {
          expect([...concurrent, rerun].reduce((total, result) => total + (result.protected[reason] ?? 0), 0)).toBe(3)
        }
        expect((await readdir(root)).sort()).toEqual([nonEmptyId, sandboxId, symlinkId].sort())
        expect(await readFile(join(nonEmptyPath, 'active.txt'), 'utf8')).toBe('keep')
        expect(await readdir(sandboxPath)).toEqual([])
        expect((await lstat(symlinkPath)).isSymbolicLink()).toBe(true)
        expect(await readFile(outsideSentinel, 'utf8')).toBe('outside')
        expect(process.cwd()).toBe(cwd)
      } catch (error) {
        console.error(
          'workspace GC rmdir boundary failure diagnostics',
          JSON.stringify(
            {
              ordering,
              invocationRoot,
              cwd: { expected: cwd, actual: process.cwd() },
              boundary: { arrivals, winnerTaken },
              tree: await captureOwnedTree(invocationRoot),
            },
            null,
            2
          )
        )
        throw error
      } finally {
        // Cleanup is restricted to this invocation's unique owned tree.
        await rm(invocationRoot, { recursive: true, force: true })
        await expect(lstat(invocationRoot)).rejects.toMatchObject({ code: 'ENOENT' })
      }
    }
  )

  it('paginates deterministically with a bounded opaque cursor', async () => {
    const root = await makeRoot()
    const ids = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()].sort()
    await Promise.all(ids.map((id) => mkdir(join(root, id))))

    const first = await reconcileWorkspaceStubs({ limit: 2 }, deps(root))
    const second = await reconcileWorkspaceStubs({ limit: 2, cursor: first.nextCursor! }, deps(root))

    expect(first.scanned).toBe(2)
    expect(first.hasMore).toBe(true)
    expect(first.nextCursor).not.toContain(ids[1])
    expect(second.scanned).toBe(1)
    expect(second.hasMore).toBe(false)
  })
})
