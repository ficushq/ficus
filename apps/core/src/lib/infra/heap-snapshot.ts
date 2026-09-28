import { chmod, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { writeHeapSnapshot } from 'node:v8'

import { expandTilde } from '@ficus/shared/node'

export interface HeapSnapshotOptions {
  role: 'api' | 'worker'
  directory: string
  now?: () => Date
  pid?: number
  mkdir?: (path: string, options: { recursive: true; mode: number }) => Promise<unknown>
  chmod?: (path: string, mode: number) => Promise<unknown>
  writeSnapshot?: (path: string) => unknown | Promise<unknown>
}

let captureInProgress = false

/** Capture one restricted heap snapshot without materializing the graph in JS. */
export async function captureHeapSnapshot(options: HeapSnapshotOptions): Promise<string> {
  if (captureInProgress) throw new Error('Heap snapshot capture already in progress')
  captureInProgress = true
  try {
    const createDirectory = options.mkdir ?? mkdir
    const restrictFile = options.chmod ?? chmod
    const writer = options.writeSnapshot ?? writeHeapSnapshot
    const directory = expandTilde(options.directory)
    await createDirectory(directory, { recursive: true, mode: 0o700 })
    // mkdir's mode does not affect an existing directory. Tighten it before
    // writeHeapSnapshot creates a secrets-bearing file inside it.
    await restrictFile(directory, 0o700)
    const timestamp = (options.now ?? (() => new Date()))().toISOString().replace(/[.:]/g, '-')
    const path = join(directory, `tau-${options.role}-${timestamp}-${options.pid ?? process.pid}.heapsnapshot`)
    await writer(path)
    await restrictFile(path, 0o600)
    return path
  } finally {
    captureInProgress = false
  }
}
