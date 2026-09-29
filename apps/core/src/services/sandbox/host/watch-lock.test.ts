import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { open } from 'fs/promises'
import type { SquadWatchLock } from './watch-lock'
import { tmpdir } from 'os'
import { join } from 'path'
import { acquireSquadWatchLock } from './watch-lock'

describe('acquireSquadWatchLock', () => {
  test('second holder is rejected until the first releases; squads are independent', async () => {
    const prev = process.env.HOME_DIR
    const home = mkdtempSync(join(tmpdir(), 'ficus-watch-lock-'))
    process.env.HOME_DIR = home
    const locks: SquadWatchLock[] = []
    const acquire = async (id: string) => {
      const lock = await acquireSquadWatchLock(id)
      if (lock) locks.push(lock)
      return lock
    }
    try {
      const first = await acquire('squad-a')
      expect(first).not.toBeNull()
      expect(await acquire('squad-a')).toBeNull() // busy
      expect(await acquire('squad-b')).not.toBeNull()
      await first!.release()
      expect(await acquire('squad-a')).not.toBeNull()
    } finally {
      await Promise.all(locks.map((lock) => lock.release()))
      if (prev === undefined) delete process.env.HOME_DIR
      else process.env.HOME_DIR = prev
      rmSync(home, { recursive: true, force: true })
    }
  })

  test('release makes the lock re-acquirable immediately', async () => {
    const prev = process.env.HOME_DIR
    const home = mkdtempSync(join(tmpdir(), 'ficus-watch-lock-rel-'))
    process.env.HOME_DIR = home
    const locks: SquadWatchLock[] = []
    const acquire = async (id: string) => {
      const lock = await acquireSquadWatchLock(id)
      if (lock) locks.push(lock)
      return lock
    }
    try {
      const lock = await acquire('squad-rel')
      expect(lock).not.toBeNull()
      await Promise.all([lock!.release(), lock!.release()])
      const neighbor = await open(join(home, 'neighbor'), 'w+')
      try {
        await lock!.release()
        await neighbor.writeFile('still open')
        expect((await neighbor.stat()).size).toBe(10)
      } finally {
        await neighbor.close()
      }
      const again = await acquire('squad-rel')
      expect(again).not.toBeNull()
      await again!.release()
    } finally {
      await Promise.all(locks.map((lock) => lock.release()))
      if (prev === undefined) delete process.env.HOME_DIR
      else process.env.HOME_DIR = prev
      rmSync(home, { recursive: true, force: true })
    }
  })
})
