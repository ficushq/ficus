/**
 * Workspace File Watcher
 *
 * Watches the workspace directory for file changes and sends updates to Ficus Core.
 * Uses chokidar for FS watching and micromatch for glob filtering.
 */

import chokidar, { type FSWatcher } from 'chokidar'
import micromatch from 'micromatch'
import { existsSync, readFileSync } from 'fs'
import { readdir, stat, readFile, lstat, realpath } from 'fs/promises'
import { join, relative } from 'path'

const DEFAULT_EXCLUDES = [
  '**/node_modules/**',
  '**/.git/**',
  '**/dist/**',
  '**/build/**',
  '**/.next/**',
  '**/.cache/**',
  '**/coverage/**',
  '**/*.min.js',
  '**/*.map',
]

interface WatchConfig {
  include: string[]
  exclude: string[]
  coreCallbackUrl?: string // Optional override; defaults to FICUS_API_URL env var
  squadId: string
}

function normalizePatterns(value: unknown, fieldName: string): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) {
    throw new Error(`Invalid watch config: ${fieldName} must be an array of glob strings`)
  }

  return value
    .map((pattern) => {
      if (typeof pattern !== 'string') {
        throw new Error(`Invalid watch config: ${fieldName} must be an array of glob strings`)
      }
      return pattern
        .trim()
        .replace(/^\/+/, '')
        .replace(/^workspace\//, '')
    })
    .filter(Boolean)
}

export function normalizeWatchConfig(config: unknown): WatchConfig {
  if (!config || typeof config !== 'object') {
    throw new Error('Invalid watch config: request body must be an object')
  }

  const raw = config as Record<string, unknown>
  const include = normalizePatterns(raw.include, 'include')
  if (include.length === 0) {
    throw new Error('Invalid watch config: include must contain at least one glob string')
  }

  const squadId = typeof raw.squadId === 'string' ? raw.squadId.trim() : ''
  if (!squadId) {
    throw new Error('Invalid watch config: squadId is required')
  }

  const normalized: WatchConfig = {
    include,
    exclude: normalizePatterns(raw.exclude, 'exclude'),
    squadId,
  }

  if (raw.coreCallbackUrl !== undefined) {
    if (typeof raw.coreCallbackUrl !== 'string') {
      throw new Error('Invalid watch config: coreCallbackUrl must be a string')
    }
    normalized.coreCallbackUrl = raw.coreCallbackUrl
  }

  return normalized
}

/** Structural equality of two already-normalized watch configs (order-sensitive on the glob lists). */
function configsEqual(a: WatchConfig, b: WatchConfig): boolean {
  return (
    a.squadId === b.squadId &&
    a.coreCallbackUrl === b.coreCallbackUrl &&
    a.include.length === b.include.length &&
    a.include.every((pattern, i) => pattern === b.include[i]) &&
    a.exclude.length === b.exclude.length &&
    a.exclude.every((pattern, i) => pattern === b.exclude[i])
  )
}

interface ScannedFile {
  path: string
  content: string
}

interface FileChange {
  path: string
  content: string | null
  event: 'change' | 'delete'
}

/** Whether a normalized watch glob stays inside the watched root (no `..` path
 *  segments). The container executor is isolated by its own fs boundary; the
 *  host runtime has no such boundary, so host callers must reject escapes. */
export function isSafeWatchPattern(pattern: string): boolean {
  return !pattern.split('/').includes('..')
}

/** Chokidar 5 accepts paths, not globs. Prune directory traversal using glob
 * prefixes, while retaining ancestors for directories/files created later.
 * Missing stats are normal for deleted paths and must not hide unlink events. */
export function createWatchPathFilter(root: string, include: string[], exclude: string[]) {
  const expanded = include.flatMap((pattern) => micromatch.braces(pattern, { expand: true }))
  const directoryPatterns = expanded.flatMap((pattern) => {
    const parts = pattern.split('/')
    const count = parts.at(-1) === '**' ? parts.length : parts.length - 1
    return Array.from({ length: count }, (_, i) => parts.slice(0, i + 1).join('/'))
  })
  const anyMatch = (patterns: string[]) => {
    const matchers = patterns.map((pattern) => micromatch.matcher(pattern))
    return (path: string) => matchers.some((match) => match(path))
  }
  const matchesFile = anyMatch(include)
  const matchesDirectory = anyMatch(directoryPatterns)
  const excluded = anyMatch([...DEFAULT_EXCLUDES, ...exclude])
  return (path: string, stats?: { isDirectory(): boolean }) => {
    const rel = relative(root, path).split('\\').join('/')
    if (!rel) return false
    if (rel === '..' || rel.startsWith('../') || excluded(rel)) return true
    const directory = matchesDirectory(rel)
    return stats ? !(stats.isDirectory() ? directory : matchesFile(rel)) : !(directory || matchesFile(rel))
  }
}

export interface ScanSkip {
  path: string
  reason: 'file_too_large' | 'binary' | 'max_files_exceeded' | 'unreadable'
  detail?: string
}

export interface ScanResult {
  files: ScannedFile[]
  skipped: ScanSkip[]
}

const MAX_FILES_PER_PATTERN = 1000
const MAX_FILE_SIZE = 100 * 1024 // 100KB

const log = (msg: string) => {
  const line = `[watcher] ${msg}\n`
  process.stdout.write(line)
}

/**
 * Read the secret for authenticating callbacks to core. Prefers the dedicated
 * SANDBOX_CALLBACK_SECRET (env var or mounted K8s Secret file at
 * /etc/tau/sandbox-callback-secret), falling back to the legacy FICUS_PASSWORD for
 * transition.
 */
function getAuthPassword(): string {
  if (process.env.SANDBOX_CALLBACK_SECRET) return process.env.SANDBOX_CALLBACK_SECRET
  const callbackSecretPath = '/etc/tau/sandbox-callback-secret'
  if (existsSync(callbackSecretPath)) {
    return readFileSync(callbackSecretPath, 'utf-8').trim()
  }
  if (process.env.FICUS_PASSWORD) return process.env.FICUS_PASSWORD
  const secretPath = '/etc/tau/password'
  if (existsSync(secretPath)) {
    return readFileSync(secretPath, 'utf-8').trim()
  }
  return ''
}

function isBinary(buffer: Buffer): boolean {
  const check = buffer.subarray(0, 512)
  for (let i = 0; i < check.length; i++) {
    if (check[i] === 0) return true
  }
  return false
}

async function walkDir(dir: string, rootDir: string): Promise<string[]> {
  const results: string[] = []
  const pending = [dir]

  while (pending.length > 0) {
    const currentDir = pending.pop()!
    let names: string[]
    try {
      names = await readdir(currentDir)
    } catch {
      continue
    }

    for (const name of names) {
      const fullPath = join(currentDir, name)
      let fileStat: Awaited<ReturnType<typeof lstat>>
      try {
        fileStat = await lstat(fullPath)
      } catch {
        continue
      }

      // Do not follow symlinks while scanning. Workspaces can contain links back
      // to parent directories (for example tool caches or user-created links),
      // and following them can recurse indefinitely until the process throws
      // "Maximum call stack size exceeded".
      if (fileStat.isSymbolicLink()) continue

      if (fileStat.isDirectory()) {
        // Skip dot-prefixed directories
        if (name.startsWith('.')) continue
        pending.push(fullPath)
      } else if (fileStat.isFile()) {
        results.push(relative(rootDir, fullPath))
      }
    }
  }

  return results
}

/**
 * Receives watcher payloads. The default delivery is the authenticated HTTP
 * callback to core; the host runtime injects an in-process sink instead so
 * events reach the same ingest path without an HTTP hop.
 */
export type WatchEventSink = (payload: {
  squadId: string
  files: FileChange[]
  reconcile: boolean
  skipped?: ScanSkip[]
}) => Promise<void>

export interface WorkspaceWatcherOptions {
  /** Receives scan/change payloads; default is the authenticated HTTP callback to core. */
  sink?: WatchEventSink
  /** Skip symlinked files on live events (host runtime: no container fs boundary). Default false. */
  rejectSymlinks?: boolean
  /** Keep the process alive for the watch (chokidar `persistent`). Default true — the
   *  executor's own process. The host runtime passes false: its api/worker processes
   *  hold their own persistent handles, and a bare watcher (e.g. a leaked one in a
   *  test process) must never single-handedly pin the event loop. */
  persistent?: boolean
}

export class WorkspaceWatcher {
  private workspacePath: string
  private config: WatchConfig | null = null
  private fsWatcher: FSWatcher | null = null
  private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private starting: Promise<{ fileCount: number; skipped: ScanSkip[] }> | null = null
  // Result of the last completed scan, returned when start() is called again with an unchanged config.
  private lastResult: { fileCount: number; skipped: ScanSkip[] } | null = null
  private sink: WatchEventSink | null
  private rejectSymlinks: boolean
  private persistent: boolean

  constructor(workspacePath = '/workspace', options: WorkspaceWatcherOptions = {}) {
    this.workspacePath = workspacePath
    this.sink = options.sink ?? null
    this.rejectSymlinks = options.rejectSymlinks === true
    this.persistent = options.persistent !== false
  }

  /**
   * Get current watcher status and config.
   */
  getStatus(): { active: boolean; config: WatchConfig | null } {
    return {
      active: this.fsWatcher !== null && this.config !== null,
      config: this.config,
    }
  }

  async start(config: WatchConfig): Promise<{ fileCount: number; skipped: ScanSkip[] }> {
    const normalizedConfig = normalizeWatchConfig(config)

    // Idempotent: core's reconcile re-issues startWatch every cycle. If we're already watching with
    // an identical (normalized) config, don't stop + full-rescan again — that repeated scan loads
    // every matched file into memory and was a periodic memory spike. Return the last scan's result.
    if (this.fsWatcher && this.config && this.lastResult && configsEqual(this.config, normalizedConfig)) {
      log('Already watching with an identical config — skipping rescan')
      return this.lastResult
    }

    // If already starting, return the in-flight promise
    if (this.starting) {
      log('Start already in progress, joining existing call')
      return this.starting
    }

    this.starting = this._start(normalizedConfig)
    try {
      return await this.starting
    } finally {
      this.starting = null
    }
  }

  private async _start(config: WatchConfig): Promise<{ fileCount: number; skipped: ScanSkip[] }> {
    // Stop any existing watcher
    await this.stop()

    // Native watcher events use canonical paths. A macOS /var or /tmp alias
    // otherwise fails the include/containment checks against /private paths.
    this.workspacePath = await realpath(this.workspacePath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return this.workspacePath
      throw error
    })

    this.config = config
    log(`Starting watcher on ${this.workspacePath}`)

    // Initial scan
    const { files, skipped } = await WorkspaceWatcher.scanFiles(this.workspacePath, {
      include: config.include,
      exclude: config.exclude,
    })

    // Send initial reconcile with skip info
    await this.sendToCore(
      files.map((f) => ({ path: f.path, content: f.content, event: 'change' as const })),
      true,
      skipped
    )

    // Watch only the include glob patterns — not the entire workspace.
    // Watching all of /workspace on NFS sets up watchers on node_modules,
    // .devbox, etc. which blocks the event loop and kills healthz.
    this.fsWatcher = chokidar.watch(this.workspacePath, {
      ignoreInitial: true,
      persistent: this.persistent,
      // Bun 1.4's macOS FSEvents backend can miss edits after chokidar's ready
      // event. Poll only the filtered workspace paths there; one-second polls
      // avoid busy scanning and fit within the existing three-second debounce.
      usePolling: process.platform === 'darwin',
      interval: 1000,
      binaryInterval: 1000,
      ignored: createWatchPathFilter(this.workspacePath, config.include, config.exclude),
      followSymlinks: false,
    })

    this.fsWatcher.on('add', (absPath) => this.handleEvent(absPath, 'change'))
    this.fsWatcher.on('change', (absPath) => this.handleEvent(absPath, 'change'))
    this.fsWatcher.on('unlink', (absPath) => this.handleEvent(absPath, 'delete'))

    // start() is the readiness boundary. Returning after allocating a watcher
    // lets an immediate write race its initial directory registration.
    const watcher = this.fsWatcher
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: unknown) => {
          watcher.off('ready', onReady)
          reject(error)
        }
        const onReady = () => {
          watcher.off('error', onError)
          resolve()
        }
        watcher.once('error', onError)
        watcher.once('ready', onReady)
      })
    } catch (error) {
      await this.stop()
      throw error
    }

    log(`Initial scan found ${files.length} files, ${skipped.length} skipped`)
    this.lastResult = { fileCount: files.length, skipped }
    return this.lastResult
  }

  async stop(): Promise<void> {
    if (this.fsWatcher) {
      await this.fsWatcher.close()
      this.fsWatcher = null
    }
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer)
    }
    this.debounceTimers.clear()
    this.config = null
    this.lastResult = null
    log('Watcher stopped')
  }

  async rescan(): Promise<{ fileCount: number; skipped: ScanSkip[] }> {
    if (!this.config) {
      throw new Error('Watcher not started')
    }

    const { files, skipped } = await WorkspaceWatcher.scanFiles(this.workspacePath, {
      include: this.config.include,
      exclude: this.config.exclude,
    })

    await this.sendToCore(
      files.map((f) => ({ path: f.path, content: f.content, event: 'change' as const })),
      true,
      skipped
    )

    log(`Rescan found ${files.length} files, ${skipped.length} skipped`)
    return { fileCount: files.length, skipped }
  }

  private handleEvent(absPath: string, event: 'change' | 'delete'): void {
    if (!this.config) return

    const relPath = relative(this.workspacePath, absPath)
    const allExcludes = [...DEFAULT_EXCLUDES, ...this.config.exclude]

    // Check if file matches include globs
    if (!micromatch.isMatch(relPath, this.config.include, { ignore: allExcludes })) {
      return
    }

    // Debounce per-file at 3 seconds
    const existing = this.debounceTimers.get(relPath)
    if (existing) clearTimeout(existing)

    this.debounceTimers.set(
      relPath,
      setTimeout(() => {
        this.debounceTimers.delete(relPath)
        this.processFileEvent(absPath, relPath, event)
      }, 3000)
    )
  }

  private async processFileEvent(absPath: string, relPath: string, event: 'change' | 'delete'): Promise<void> {
    if (event === 'delete') {
      log(`File deleted: ${relPath}`)
      await this.sendToCore([{ path: relPath, content: null, event: 'delete' }], false)
      return
    }

    if (this.rejectSymlinks) {
      const linkStat = await lstat(absPath).catch(() => null)
      if (linkStat?.isSymbolicLink()) {
        log(`Skipping ${relPath}: symlink`)
        return
      }
    }

    try {
      const fileStat = await stat(absPath)
      if (fileStat.size > MAX_FILE_SIZE) {
        log(`Skipping ${relPath}: ${Math.round(fileStat.size / 1024)}KB exceeds ${MAX_FILE_SIZE / 1024}KB limit`)
        return
      }
      const buffer = await readFile(absPath)
      if (isBinary(buffer)) return
      log(`File changed: ${relPath} (${Math.round(fileStat.size / 1024)}KB)`)
      const content = buffer.toString('utf-8')
      await this.sendToCore([{ path: relPath, content, event: 'change' }], false)
    } catch {
      // File may have been deleted between event and read
    }
  }

  private getCallbackUrl(): string {
    if (this.config?.coreCallbackUrl) return this.config.coreCallbackUrl
    const apiUrl = process.env.FICUS_API_URL || 'http://localhost:3000'
    return `${apiUrl}/api/memory/${this.config!.squadId}/workspace-files`
  }

  private async sendToCore(files: FileChange[], reconcile: boolean, skipped?: ScanSkip[]): Promise<void> {
    if (!this.config) return

    const payload = {
      squadId: this.config.squadId,
      files,
      reconcile,
      ...(skipped && skipped.length > 0 ? { skipped } : {}),
    }

    try {
      if (this.sink) {
        await this.sink(payload)
        return
      }
      await this.postToCore(payload)
    } catch (err: any) {
      log(`Core callback error: ${err.message}`)
    }
  }

  private async postToCore(payload: {
    squadId: string
    files: FileChange[]
    reconcile: boolean
    skipped?: ScanSkip[]
  }): Promise<void> {
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      const password = getAuthPassword()
      if (password) {
        headers['Authorization'] = `Bearer ${password}`
      }

      const response = await fetch(this.getCallbackUrl(), {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
      })
      if (!response.ok) {
        log(`Core callback failed: ${response.status} ${response.statusText}`)
      }
    } catch (err: any) {
      log(`Core callback error: ${err.message}`)
    }
  }

  static async scanFiles(rootDir: string, opts: { include: string[]; exclude: string[] }): Promise<ScanResult> {
    const allPaths = await walkDir(rootDir, rootDir)
    const allExcludes = [...DEFAULT_EXCLUDES, ...opts.exclude]

    // Match per include pattern to enforce per-pattern file limits
    const matchedSet = new Set<string>()
    const skipped: ScanSkip[] = []

    for (const pattern of opts.include) {
      const patternMatches = micromatch(allPaths, [pattern], { ignore: allExcludes })
      if (patternMatches.length > MAX_FILES_PER_PATTERN) {
        log(`Pattern "${pattern}" matched ${patternMatches.length} files (limit: ${MAX_FILES_PER_PATTERN}), truncating`)
        // Add the ones we're keeping
        for (let i = 0; i < MAX_FILES_PER_PATTERN; i++) {
          matchedSet.add(patternMatches[i])
        }
        // Record the skipped ones
        for (let i = MAX_FILES_PER_PATTERN; i < patternMatches.length; i++) {
          skipped.push({
            path: patternMatches[i],
            reason: 'max_files_exceeded',
            detail: `Pattern "${pattern}" exceeded ${MAX_FILES_PER_PATTERN} file limit (${patternMatches.length} matched)`,
          })
        }
      } else {
        for (const p of patternMatches) {
          matchedSet.add(p)
        }
      }
    }

    const files: ScannedFile[] = []
    for (const relPath of matchedSet) {
      try {
        const absPath = join(rootDir, relPath)
        const fileStat = await stat(absPath)

        if (fileStat.size > MAX_FILE_SIZE) {
          skipped.push({
            path: relPath,
            reason: 'file_too_large',
            detail: `${Math.round(fileStat.size / 1024)}KB exceeds ${MAX_FILE_SIZE / 1024}KB limit`,
          })
          continue
        }

        const buffer = await readFile(absPath)
        if (isBinary(buffer)) {
          skipped.push({ path: relPath, reason: 'binary' })
          continue
        }

        files.push({ path: relPath, content: buffer.toString('utf-8') })
      } catch {
        skipped.push({ path: relPath, reason: 'unreadable' })
      }
    }

    if (skipped.length > 0) {
      log(
        `Skipped ${skipped.length} files: ${skipped.filter((s) => s.reason === 'file_too_large').length} too large, ${skipped.filter((s) => s.reason === 'binary').length} binary, ${skipped.filter((s) => s.reason === 'max_files_exceeded').length} over limit, ${skipped.filter((s) => s.reason === 'unreadable').length} unreadable`
      )
    }

    return { files, skipped }
  }
}
