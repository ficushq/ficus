import { parseDfOutput } from '../machines/machine-health'

/**
 * Remote side of the incremental storage scanner: fixed command templates and
 * their parsers. Nothing here touches the database.
 *
 * Directory paths never appear in a command string. They are written to the
 * remote command's stdin NUL-terminated and reach du/find through `xargs -0` as
 * the positional "$1" of a fixed `sh -c` script, so no directory name is ever
 * parsed by a shell. Each path's output is followed by a `#<exit status>`
 * marker record, which tells the parser exactly which paths finished before a
 * timeout. Records are NUL-terminated, so names may contain tabs or newlines.
 *
 * Traversal rules match the previous whole-machine scan: -x (du) and the device
 * check (listing) stay on one filesystem; du's default -P and find's default -P
 * never follow symlinks; stderr is discarded (never exposed). Every chunk runs
 * at the lowest CPU and I/O priority, and `timeout` kills the whole remote
 * process group (with SIGKILL 5s later) even if the SSH connection drops.
 */

/** Remote time limit for one chunk. */
export const CHUNK_TIMEOUT_SECONDS = 20
/** Local SSH limit: the remote limit plus the kill grace and connection slack. */
export const CHUNK_SSH_TIMEOUT_MS = (CHUNK_TIMEOUT_SECONDS + 5 + 15) * 1000
/** Remote time limit for one home's total-only du ({@link TOTAL_COMMAND}). */
export const TOTAL_TIMEOUT_SECONDS = 180
/** Local SSH limit for a total-only du, sized like {@link CHUNK_SSH_TIMEOUT_MS}. */
export const TOTAL_SSH_TIMEOUT_MS = (TOTAL_TIMEOUT_SECONDS + 5 + 15) * 1000
/** Deepest folder shown in the breakdown: /home/box_x/a/b/c (as with du --max-depth=4 /home). */
export const DETAIL_SEGMENTS = 5

const prefix = (seconds: number) => `sudo -n timeout -k 5s ${seconds}s nice -n 19 ionice -c 3 xargs -0 -r -n 1 sh -c`
const PREFIX = prefix(CHUNK_TIMEOUT_SECONDS)
const DF = "export LC_ALL=C; df -B1 --output=used,size /home; printf '\\0';"

/** Path segments: /home/box_x is 2. */
export const segments = (path: string) => path.split('/').length - 1

const BOX_HOME = /^\/home\/box_[a-f0-9]{12}$/

/** A canonical directory path inside a box home. Anything else is never sent or stored. */
export function isScanPath(path: string): boolean {
  const parts = path.split('/')
  if (parts.length < 3 || !BOX_HOME.test(parts.slice(0, 3).join('/'))) return false
  return parts.slice(3).every((part) => part !== '' && part !== '.' && part !== '..' && !part.includes('\0'))
}

/** du's --max-depth for a path so that output stops at {@link DETAIL_SEGMENTS}. */
export const detailDepth = (path: string) => Math.max(0, DETAIL_SEGMENTS - segments(path))

/** Measure each stdin path with du (hardlinks are counted once per path). */
export function measureCommand(maxDepth: number): string {
  if (!Number.isInteger(maxDepth) || maxDepth < 0 || maxDepth > DETAIL_SEGMENTS) throw new Error('invalid depth')
  return `${DF} ${PREFIX} 'du -x -B1 --null --max-depth=${maxDepth} -- "$1" 2>/dev/null; printf "#%s\\0" "$?"' sh`
}

/**
 * Measure only each stdin path's total, with one du for the whole path: a file hard-linked into
 * several of its subdirectories is counted once (separate du runs over the parts count it in each).
 */
export const TOTAL_COMMAND = `${DF} ${prefix(TOTAL_TIMEOUT_SECONDS)} 'du -x -s -B1 --null -- "$1" 2>/dev/null; printf "#%s\\0" "$?"' sh`

/** List each stdin path's immediate entries: device, type, inode, link count, 512-byte blocks, name. */
export const LIST_COMMAND = `${DF} ${PREFIX} 'find "$1" -maxdepth 1 -printf "%D\\t%y\\t%i\\t%n\\t%b\\t%P\\0" 2>/dev/null; printf "#%s\\0" "$?"' sh`

/** The stdin for a chunk. Paths are validated again here, right before they leave the process. */
export function chunkInput(paths: string[]): string {
  for (const path of paths) if (!isScanPath(path)) throw new Error('invalid scan path')
  return paths.map((path) => `${path}\0`).join('')
}

export interface PathOutput {
  /** The marker arrived: this path's command finished. */
  complete: boolean
  exitCode: number | null
  records: string[]
}

export interface ChunkOutput {
  disk: { usedBytes: number; totalBytes: number } | null
  /** One per input path, in input order. */
  paths: PathOutput[]
}

/** Split chunk stdout into the df reading and per-path records. Truncated tails are dropped. */
export function parseChunkOutput(stdout: string, count: number): ChunkOutput {
  const paths: PathOutput[] = Array.from({ length: count }, () => ({ complete: false, exitCode: null, records: [] }))
  const separator = stdout.indexOf('\0')
  if (separator < 0) return { disk: null, paths }
  const disk = parseDfOutput(stdout.slice(0, separator))
  // The last element is either '' (complete output) or a record cut off mid-write.
  const records = stdout
    .slice(separator + 1)
    .split('\0')
    .slice(0, -1)
  let index = 0
  for (const record of records) {
    if (index >= count) break
    const marker = /^#(\d+)$/.exec(record)
    if (marker) {
      paths[index] = { ...paths[index]!, complete: true, exitCode: Number(marker[1]) }
      index++
    } else paths[index]!.records.push(record)
  }
  return { disk, paths }
}

/** du records for `root` and its descendants (anything else is ignored). */
export function parseDuRecords(records: string[], root: string): Map<string, number> {
  const entries = new Map<string, number>()
  for (const record of records) {
    const tab = record.indexOf('\t')
    if (tab < 1) continue
    const size = record.slice(0, tab)
    const path = record.slice(tab + 1)
    if (!/^\d+$/.test(size) || !Number.isSafeInteger(Number(size))) continue
    if ((path !== root && !path.startsWith(`${root}/`)) || !isScanPath(path)) continue
    entries.set(path, Number(size))
  }
  return entries
}

export interface DirectoryListing {
  /** The directory's own blocks plus its non-directory entries (hardlinks once). */
  directBytes: number
  /** Immediate subdirectories on the same filesystem (full paths). */
  subdirectories: string[]
}

/** Parse a find listing of `root`. Null when the root itself was not listed (gone or unreadable). */
export function parseListRecords(records: string[], root: string): DirectoryListing | null {
  let device: string | null = null
  let directBytes = 0
  const seen = new Set<string>()
  const entries: Array<{ device: string; type: string; inode: string; links: number; bytes: number; name: string }> = []
  for (const record of records) {
    const fields = record.split('\t')
    if (fields.length < 6) continue
    const [dev, type, inode, links, blocks] = fields as [string, string, string, string, string]
    const name = fields.slice(5).join('\t')
    if (!/^\d+$/.test(dev) || !/^\d+$/.test(blocks) || !/^\d+$/.test(links)) continue
    const bytes = Number(blocks) * 512
    if (!Number.isSafeInteger(bytes)) continue
    if (name === '') {
      device = dev
      directBytes += bytes
      continue
    }
    entries.push({ device: dev, type: type!, inode: inode!, links: Number(links), bytes, name })
  }
  if (device === null) return null
  const subdirectories: string[] = []
  for (const entry of entries) {
    if (entry.type === 'd') {
      // Another filesystem mounted here: du -x would not count it either.
      if (entry.device !== device) continue
      const path = `${root}/${entry.name}`
      if (!entry.name.includes('/') && isScanPath(path)) subdirectories.push(path)
      continue
    }
    if (entry.links > 1) {
      const key = `${entry.device}:${entry.inode}`
      if (seen.has(key)) continue
      seen.add(key)
    }
    directBytes += entry.bytes
  }
  return { directBytes, subdirectories: subdirectories.sort() }
}
