import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { createLogger } from '../../lib/infra/logger'
import { createPeriodicRunner, type PeriodicRunner } from '../../lib/infra/PeriodicRunner'
import { parseShellLiteralAssignments } from './shell-literal-assignments'
import { getSquadsBasePath, isCanonicalSquadId } from '../squad/workspace'
import {
  DbSquadEnvDetectionRepository,
  MAX_SQUAD_ENV_BYTES,
  type SquadEnvDetectionRecord,
  type SquadEnvDetectionRepository,
  type SquadEnvSnapshot,
} from './squad-env-detection-repository'
import type { SecretEntry } from './content-safety'

export { MAX_SQUAD_ENV_BYTES }
const log = createLogger('squad-env-detection')
const FILE_SCAN_MS = 1000
const DB_REFRESH_MS = 15_000
const SECRET_NAME = /(?:^|_)(?:TOKEN|KEY|SECRET|PASSWORD|CREDENTIALS)$/i

/** Literal values only; never source a shell file or evaluate substitutions. */
export function isSecretLikeSquadEnvValue(key: string, value: string): boolean {
  if (/PUBLIC|PUBLISHABLE/i.test(key) || /^(?:NEXT_PUBLIC_|VITE_|REACT_APP_)/i.test(key)) return false
  if (value.length < 12) return false
  if (SECRET_NAME.test(key)) return true
  if (value.length < 32 || /\s/.test(value) || /^(?:https?:|\/|\.{1,2}\/|~\/)/i.test(value)) return false
  // SHA-1 commit IDs and explicitly named digests are public identifiers, not
  // credentials. Long generic hex remains heuristic: its alphabet tops out at
  // four bits, so the base64-like threshold below cannot detect it reliably.
  const hex = /^[a-f0-9]+$/i.test(value)
  if (hex && (value.length < 64 || /(?:^|_)(?:COMMIT|SHA\d*|HASH|CHECKSUM|REVISION)(?:_|$)/i.test(key))) return false
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((pattern) => pattern.test(value)).length
  if (classes < 2) return false
  const counts = new Map<string, number>()
  for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1)
  let entropy = 0
  for (const count of counts.values()) {
    const probability = count / value.length
    entropy -= probability * Math.log2(probability)
  }
  return entropy >= (hex ? 3.5 : 4)
}

export function assertSquadEnvSize(content: string): void {
  if (Buffer.byteLength(content, 'utf8') > MAX_SQUAD_ENV_BYTES) throw new Error('Squad environment exceeds 256 KiB')
}

function snapshot(content: Buffer): SquadEnvSnapshot & { contentHash: string } {
  return {
    contentHash: createHash('sha256').update(content).digest('hex'),
    entries: parseShellLiteralAssignments(content.toString('utf8')).filter(({ key, value }) =>
      isSecretLikeSquadEnvValue(key, value)
    ),
    reason: null,
  }
}

/** Bounded even if an agent grows/replaces the file after the metadata check. */
function readBounded(path: string): Buffer {
  if (realpathSync(path) !== path) throw new Error('Noncanonical squad environment path')
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile()) throw new Error('Not a regular squad environment file')
    if (stat.size > MAX_SQUAD_ENV_BYTES) throw Object.assign(new Error(), { code: 'ENV_TOO_LARGE' })
    const buffer = Buffer.alloc(MAX_SQUAD_ENV_BYTES + 1)
    let size = 0
    while (size < buffer.length) {
      const read = readSync(fd, buffer, size, buffer.length - size, size)
      if (!read) break
      size += read
    }
    if (size > MAX_SQUAD_ENV_BYTES) throw Object.assign(new Error(), { code: 'ENV_TOO_LARGE' })
    return buffer.subarray(0, size)
  } finally {
    closeSync(fd)
  }
}

const NOTICES = {
  oversized:
    'Output redaction is unavailable for this environment: it exceeds 256 KiB. Save a smaller environment in Settings.',
  unreadable:
    'Output redaction is unavailable for this environment: trusted state or the environment file is unreadable. Save it again in Settings.',
  mismatch:
    'This environment was edited outside Settings; its changed values are not registered for output redaction. Save it in Settings to register them.',
} as const

type CachedFile = {
  signature: string
  hash: string
  // Candidates and hash always come from the same bounded bytes. They are not
  // registered unless the protected DB authority matches this observation.
  candidates: readonly SecretEntry[]
  matchesTrusted: boolean
  entries: readonly SecretEntry[]
}

/** DB-authoritative output-only source; the mutable workspace never grants authority after bootstrap. */
export class SquadEnvSecretSource {
  #records = new Map<string, SquadEnvSnapshot | undefined>()
  #files = new Map<string, CachedFile>()
  #entries: readonly SecretEntry[] = []
  #notices = new Map<string, string>()
  #warned = new Set<string>()
  #lastScan = -Infinity
  #writeRevision = 0
  #runner?: PeriodicRunner
  readonly #repository: SquadEnvDetectionRepository
  readonly #now: () => number
  readonly #warn: (message: string) => void

  constructor(
    private readonly basePath: () => string = getSquadsBasePath,
    options: { repository?: SquadEnvDetectionRepository; now?: () => number; warn?: (message: string) => void } = {}
  ) {
    this.#repository = options.repository ?? new DbSquadEnvDetectionRepository()
    this.#now = options.now ?? Date.now
    this.#warn = options.warn ?? ((message) => log.warn(message))
  }

  async initialize(): Promise<void> {
    const root = this.canonicalRoot()
    for (const id of await this.#repository.pendingSquads()) {
      if (!isCanonicalSquadId(id)) continue
      let initial: SquadEnvSnapshot = { contentHash: null, entries: [], reason: null }
      try {
        initial = snapshot(readBounded(this.path(id, root)))
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code !== 'ENOENT') initial.reason = code === 'ENV_TOO_LARGE' ? 'oversized' : 'unreadable'
      }
      // Repository rechecks the separate durable marker under a row lock.
      // Concurrent API saves win; missing/malformed records never reset it.
      await this.#repository.bootstrap(id, initial)
    }
    await this.refresh()
    this.#lastScan = -Infinity
    this.entries()
  }

  async refresh(): Promise<void> {
    const revision = this.#writeRevision
    const records = await this.#repository.list()
    if (revision !== this.#writeRevision) return
    this.#records = new Map(records.map(({ squadId, snapshot }) => [squadId, snapshot]))
  }

  start(): void {
    if (this.#runner) return
    this.#runner = createPeriodicRunner({
      name: 'squad-env-detection',
      intervalMs: DB_REFRESH_MS,
      runImmediately: false,
      task: () => this.refresh(),
    })
    this.#runner.start()
  }

  async stop(): Promise<void> {
    await this.#runner?.stop()
    this.#runner = undefined
  }

  async recordWrite(squadId: string, content: string, write?: () => void): Promise<void> {
    assertSquadEnvSize(content)
    await this.persistWrite(squadId, snapshot(Buffer.from(content, 'utf8')), write)
  }

  /** Preserve full legacy runtime content without registering oversized values.
   * Only missing-env.user promotion uses this exception; ordinary writes stay capped.
   */
  async recordLegacyPromotion(squadId: string, content: string, write: () => void): Promise<void> {
    if (Buffer.byteLength(content, 'utf8') <= MAX_SQUAD_ENV_BYTES) {
      await this.recordWrite(squadId, content, write)
      return
    }
    await this.persistWrite(squadId, { contentHash: null, entries: [], reason: 'oversized' }, write)
  }

  private async persistWrite(squadId: string, trusted: SquadEnvSnapshot, write?: () => void): Promise<void> {
    await this.#repository.save(squadId, trusted, write)
    this.accept({ squadId, snapshot: trusted })
  }

  private accept(record: SquadEnvDetectionRecord): void {
    this.#writeRevision++
    this.#records.set(record.squadId, record.snapshot)
    // API/service writes are the deliberate immediate-refresh exception.
    this.#lastScan = -Infinity
    this.entries()
  }

  private canonicalRoot(): string {
    const root = this.basePath()
    try {
      return realpathSync(root)
    } catch {
      return root
    }
  }

  private path(id: string, root: string): string {
    return join(root, id, '.ficus', 'env.user')
  }

  notice(squadId: string): string | undefined {
    this.entries()
    return this.#notices.get(squadId)
  }

  private warn(squadId: string, reason: keyof typeof NOTICES): void {
    this.#notices.set(squadId, NOTICES[reason])
    if (this.#warned.has(squadId)) return
    this.#warned.add(squadId)
    this.#warn(`Squad ${squadId}: ${NOTICES[reason]}`)
  }

  entries(): readonly SecretEntry[] {
    const now = this.#now()
    if (now - this.#lastScan < FILE_SCAN_MS) return this.#entries
    // Set before warnings: their sanitizer calls back into this same source.
    this.#lastScan = now
    this.#notices.clear()
    const next = new Map<string, CachedFile>()
    const root = this.canonicalRoot()
    for (const [id, trusted] of this.#records) {
      if (!isCanonicalSquadId(id)) continue
      if (trusted?.reason) {
        this.warn(id, trusted.reason)
        continue
      }
      try {
        const path = this.path(id, root)
        const stat = lstatSync(path, { bigint: true })
        if (!stat.isFile()) {
          this.warn(id, 'unreadable')
          continue
        }
        if (stat.size > BigInt(MAX_SQUAD_ENV_BYTES)) {
          this.warn(id, 'oversized')
          continue
        }
        if (!trusted) {
          this.warn(id, 'unreadable')
          continue
        }
        const signature = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`
        const cached = this.#files.get(id)
        // Cache observations, not just accepted matches. An unchanged mismatch
        // or null-hash record must not re-read file bytes on each sanitizer tick.
        let hash: string
        let candidates: readonly SecretEntry[]
        if (cached && cached.signature === signature) {
          ;({ hash, candidates } = cached)
        } else {
          // Persisted entries were heuristic output, not explicit credential
          // registrations. Re-evaluate policy on upgrade without resnapshotting
          // authority: only the existing protected hash can authorize these bytes.
          const observed = snapshot(readBounded(path))
          hash = observed.contentHash
          candidates = observed.entries.map(({ value }) => ({ key: 'squad-env', value, outputOnly: true }))
        }
        const matchesTrusted = hash === trusted.contentHash
        if (cached && cached.signature === signature && cached.matchesTrusted === matchesTrusted) {
          next.set(id, cached)
        } else {
          next.set(id, {
            signature,
            hash,
            candidates,
            matchesTrusted,
            entries: matchesTrusted ? candidates : [],
          })
        }
        if (!matchesTrusted) this.warn(id, 'mismatch')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.warn(id, 'unreadable')
      }
    }
    if (next.size !== this.#files.size || [...next].some(([id, file]) => this.#files.get(id) !== file)) {
      this.#files = next
      this.#entries = [...next.values()].flatMap(({ entries }) => entries)
    }
    return this.#entries
  }
}

let processSource: SquadEnvSecretSource | undefined
export function getSquadEnvSecretSource(): SquadEnvSecretSource {
  return (processSource ??= new SquadEnvSecretSource())
}
export async function initializeSquadEnvSecretSource(): Promise<void> {
  const source = getSquadEnvSecretSource()
  await source.initialize()
  source.start()
}
export async function resetSquadEnvSecretSource(): Promise<void> {
  await processSource?.stop()
  processSource = undefined
}
