import type { Snapshot } from './snapshot'

/** Opaque to callers: base64url of the normalized snapshot, versioned so old cursors fail loudly. */
export function encodeCursor(snapshot: Snapshot): string {
  return Buffer.from(JSON.stringify(snapshot)).toString('base64url')
}

export function decodeCursor(cursor: string): Snapshot {
  let value: unknown
  try {
    value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
  } catch {
    throw new Error('Invalid --cursor: not a ficus watch cursor')
  }
  const v = value as Partial<Snapshot> | null
  const isMap = (x: unknown) => typeof x === 'object' && x !== null && !Array.isArray(x)
  if (!v || v.v !== 1 || !isMap(v.streams) || !isMap(v.actions) || !isMap(v.inbox)) {
    throw new Error('Invalid --cursor: unsupported version or shape (get a fresh one from ficus watch output)')
  }
  return v as Snapshot
}
