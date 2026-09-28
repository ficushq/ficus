/**
 * Machine-wide single-owner election for a squad's host workspace watch.
 *
 * Core runs as two processes (api + worker) and both may ensure the same
 * squad sandbox; without election each would watch the same directory and
 * duplicate every ingest event. Ownership is a non-blocking kernel flock on
 * `<HOME_DIR>/watch-locks/squad-<squadId>.lock`: released by release(), by
 * process exit, or by fd close — never stale.
 */

import { mkdirSync } from 'fs'
import { open } from 'fs/promises'
import { join } from 'path'
import { getHomeDir } from '../../../lib/utils/home'
import { advisoryLock } from '@ficus/shared/advisory-lock'

export interface SquadWatchLock {
  release(): Promise<void>
}

export async function acquireSquadWatchLock(squadId: string): Promise<SquadWatchLock | null> {
  const dir = join(getHomeDir(), 'watch-locks')
  mkdirSync(dir, { recursive: true })
  const file = await open(join(dir, `squad-${squadId}.lock`), 'a')
  try {
    if (!(await advisoryLock(file.fd, 'lock'))) {
      await file.close()
      return null
    }
  } catch (error) {
    await file.close()
    throw error
  }
  // Closing the owned handle releases flock. Retain one close promise so a
  // repeated/concurrent cleanup cannot close a descriptor reused by another file.
  let released: Promise<void> | undefined
  return { release: () => (released ??= file.close()) }
}
