import { createHash, randomUUID } from 'node:crypto'
import { advisoryLock as defaultAdvisoryLock } from '@ficus/shared/advisory-lock'
import { link, mkdir, open, opendir, readFile, readdir, rename, unlink, type FileHandle } from 'node:fs/promises'
import { dirname, join } from 'node:path'
export type InvocationState =
  | 'starting'
  | 'running'
  | 'cancelling'
  | 'quarantined'
  | 'success'
  | 'failed'
  | 'terminated'
export interface BashInvocationRecord {
  version: 1
  invocationIdHash: string
  generation: number
  commandDigest: string
  state: InvocationState
  startedAt: string
  terminalAt?: string
  cancelRequestedAt?: string
  cancelReason?: string
  priorState?: InvocationState
  quarantinedAt?: string
  reasonCode?: string
  pid?: number
  pgid?: number
  sid?: number
  startToken?: string
  startTicks?: number // legacy Linux record compatibility
}
export interface StartingProcessRecord {
  pid: number
  startToken: string
  pgid?: number
  sid?: number
}
export interface ProcessRecord extends StartingProcessRecord {
  pgid: number
  sid: number
}
export class InvocationQuarantinedError extends Error {
  readonly code = 'INVOCATION_QUARANTINED'
  constructor() {
    super('bash invocation is quarantined pending exact cleanup proof')
  }
}
export class InvocationActiveError extends Error {
  readonly code = 'INVOCATION_ACTIVE'
  constructor() {
    super('bash invocation is already active')
  }
}
interface Options {
  runtimeDir: string
  reconcile(record: BashInvocationRecord): Promise<void>
  now?: () => Date
  terminalRetentionMs?: number
  maxTerminalRecords?: number
  minRecentTerminalRecords?: number
  pruneEveryOperations?: number
  pruneAtRecordCount?: number
  unlink?: typeof unlink
  writeRecord?: (file: FileHandle, contents: string) => Promise<void>
  legacyMigrationBatchSize?: number
  fileLockAttempts?: number
  beforeTerminalUnlink?: (path: string) => Promise<void>
  advisoryLock?: (fd: number, operation: 'lock' | 'unlock') => Promise<boolean>
  afterFileLock?: () => Promise<void>
  onLegacyBatch?: (inspectedEntries: number) => void
}

export interface BashInvocationLease {
  generation: number
  markStarting(process: StartingProcessRecord): Promise<void>
  markRunning(process: ProcessRecord): Promise<void>
  complete(state: Extract<InvocationState, 'success' | 'failed' | 'terminated'>): Promise<void>
}
export class BashInvocationRegistry {
  private readonly active = new Map<string, BashInvocationRecord>()
  private readonly locks = new Map<string, Promise<void>>()
  private maintenanceOperations = 0
  constructor(private readonly options: Options) {}
  /** Keep the executor alive until every owned invocation's terminal proof is durable.
   * Storage failure can leave a completed process with an older starting record
   * on disk. Losing our in-memory proof then makes that record unrecoverable.
   */
  hasActiveInvocations(): boolean {
    return this.active.size > 0
  }
  private async persistOwnedCompletion(key: string, current: BashInvocationRecord): Promise<boolean> {
    const owned = this.active.get(key)
    if (!owned || owned.generation !== current.generation || !owned.terminalAt) return false
    await this.archiveTerminal(key, owned)
    this.active.delete(key)
    return true
  }
  async reconcileAll(): Promise<{ reconciled: string[]; quarantined: string[] }> {
    const report = { reconciled: [] as string[], quarantined: [] as string[] }
    await mkdir(this.options.runtimeDir, { recursive: true, mode: 0o700 })
    await this.pruneTerminalRecords()
    await this.migrateLegacyBatch(report, true)
    return report
  }
  async terminateAll(): Promise<void> {
    const records = [...this.active.entries()]
    await Promise.all(
      records.map(([key, record]) =>
        this.lock(key, async () => {
          const current = await this.readValidated(key)
          if (!current || current.generation !== record.generation) return
          if (await this.persistOwnedCompletion(key, current)) return
          await this.options.reconcile(current)
          current.priorState = current.state
          current.state = 'terminated'
          current.terminalAt = this.now().toISOString()
          await this.archiveTerminal(key, current)
          this.active.delete(key)
        })
      )
    )
  }
  async terminate(invocationId: string, reason = 'cancel'): Promise<{ remainingPids: [] }> {
    const key = createHash('sha256').update(invocationId).digest('hex')
    const result = await this.lock<{ remainingPids: [] }>(key, async () => {
      const record = await this.readValidated(key)
      if (record && (await this.persistOwnedCompletion(key, record))) return { remainingPids: [] }
      if (!record || !['starting', 'running', 'cancelling', 'quarantined'].includes(record.state))
        return { remainingPids: [] }
      if (record.state === 'quarantined' && !record.pid) throw new InvocationQuarantinedError()
      record.priorState = record.state
      if (record.state !== 'starting' || (record.pgid !== undefined && record.sid !== undefined))
        record.state = 'cancelling'
      record.cancelRequestedAt = this.now().toISOString()
      record.cancelReason = reason
      await this.write(key, record)
      await this.options.reconcile(record)
      record.state = 'terminated'
      record.terminalAt = this.now().toISOString()
      await this.archiveTerminal(key, record)
      this.active.delete(key)
      return { remainingPids: [] }
    })
    await this.maybePrune()
    return result
  }
  async acquire(invocationId: string, commandDigest: string): Promise<BashInvocationLease> {
    const key = createHash('sha256').update(invocationId).digest('hex')
    // Maintenance must not throw after publishing a reservation: the caller
    // would never receive its lease and could not complete a failed admission.
    await this.maybePrune()
    let unpublishedLease: BashInvocationLease | undefined
    try {
      const lease = await this.lock<BashInvocationLease>(key, async () => {
        if (this.active.has(key)) throw new InvocationActiveError()
        await mkdir(this.options.runtimeDir, { recursive: true, mode: 0o700 })
        const previous = (await this.readValidated(key)) ?? (await this.readGeneration(key))
        if (previous?.state === 'quarantined') throw new InvocationQuarantinedError()
        // A `previous` record read from DISK is never a concurrently-live invocation:
        // the active.has(key) check above already rejects an in-flight invocation in
        // this process, so `previous` is always a prior-lifecycle record — terminal, or
        // a zombie starting/running/cancelling left by a died worker or an older core
        // release. It is therefore always safe to supersede it (archive a terminal
        // record, or reconcile+terminate a zombie) REGARDLESS of whether its command
        // digest matches.
        //
        // The previous unconditional `throw INVOCATION_COMMAND_MISMATCH` on a digest
        // change permanently wedged the STABLE setup invocation ids (git_config,
        // devbox_install, …), which are reused across retries and across core upgrades
        // that change the exact command string: once a record existed, every retry with
        // a differing command threw before reaching the supersede logic below, so the
        // sandbox setup retry loop deadlocked (observed live — git-credential setup
        // stuck ready_degraded forever, and squad-warmup exit 127 every cycle).
        if (previous && ['success', 'failed', 'terminated'].includes(previous.state))
          await this.archiveTerminal(key, previous)
        else if (previous && ['starting', 'running', 'cancelling'].includes(previous.state)) {
          await this.options.reconcile(previous)
          previous.priorState = previous.state
          previous.state = 'terminated'
          previous.terminalAt = this.now().toISOString()
          await this.archiveTerminal(key, previous)
        }
        const record: BashInvocationRecord = {
          version: 1,
          invocationIdHash: key,
          generation: (previous?.generation ?? -1) + 1,
          commandDigest,
          state: 'starting',
          startedAt: this.now().toISOString(),
        }
        await this.write(key, record)
        this.active.set(key, record)
        let completed = false
        unpublishedLease = {
          generation: record.generation,
          markStarting: async (process) =>
            this.lock(key, async () => {
              if (completed) throw new Error('invocation already completed')
              const current = await this.readValidated(key)
              if (!current || current.generation !== record.generation) throw new InvocationActiveError()
              Object.assign(record, process)
              await this.write(key, record)
            }),
          markRunning: async (process) =>
            this.lock(key, async () => {
              if (completed) throw new Error('invocation already completed')
              const current = await this.readValidated(key)
              if (!current || current.generation !== record.generation) throw new InvocationActiveError()
              Object.assign(record, process, { state: 'running' as const })
              await this.write(key, record)
            }),
          complete: async (state) => {
            await this.lock(key, async () => {
              if (completed || this.active.get(key) !== record) return
              const current = await this.readValidated(key)
              if (!current || current.generation !== record.generation) {
                completed = true
                this.active.delete(key)
                return
              }
              // Preserve the first proven outcome/timestamp across persistence
              // retries, including an already-published immutable terminal file.
              if (!record.terminalAt) {
                record.state = state
                record.terminalAt = this.now().toISOString()
              }
              await this.archiveTerminal(key, record)
              completed = true
              this.active.delete(key)
            })
            await this.maybePrune()
          },
        }
        return unpublishedLease
      })
      return lease
    } catch (error) {
      // No caller has received the lease, so no command can have spawned.
      // Retain its in-memory terminal proof if storage is still unavailable.
      try {
        await unpublishedLease?.complete('failed')
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'Bash reservation rollback could not be persisted')
      }
      throw error
    }
  }
  private async lock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prior = this.locks.get(key) ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>((resolve) => {
      release = resolve
    })
    const chained = prior.then(() => current)
    this.locks.set(key, chained)
    await prior
    let releaseFileLock: (() => Promise<void>) | undefined
    try {
      releaseFileLock = await this.acquireFileLock(key)
      return await fn()
    } finally {
      try {
        await releaseFileLock?.()
      } finally {
        release()
        if (this.locks.get(key) === chained) this.locks.delete(key)
      }
    }
  }
  private async acquireFileLock(key: string): Promise<() => Promise<void>> {
    const lockDir = join(this.options.runtimeDir, 'locks')
    await mkdir(lockDir, { recursive: true, mode: 0o700 })
    // A fixed shard set bounds lock metadata even when invocation IDs are unique.
    // Kernel advisory ownership is attached to the open descriptor and is
    // released automatically on process death/OOM; the persistent shard file
    // is never unlinked, avoiding inode replacement races between contenders.
    const file = await open(join(lockDir, `${key.slice(0, 2)}.lock`), 'a+', 0o600)
    const advisory = this.options.advisoryLock ?? defaultAdvisoryLock
    const attempts = this.options.fileLockAttempts ?? 500
    try {
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        if (await advisory(file.fd, 'lock')) {
          await this.options.afterFileLock?.()
          return async () => {
            try {
              if (!(await advisory(file.fd, 'unlock'))) throw new Error('FILESYSTEM_LOCK_RELEASE_FAILED')
            } finally {
              await file.close()
            }
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
    } catch (error) {
      await file.close()
      throw error
    }
    await file.close()
    throw new InvocationActiveError()
  }
  private now(): Date {
    return this.options.now?.() ?? new Date()
  }
  private async readValidated(key: string): Promise<BashInvocationRecord | undefined> {
    const record = await this.read(key)
    if (!record) return undefined
    return this.validateRecord(key, record)
  }
  private validateRecord(key: string, record: BashInvocationRecord): BashInvocationRecord {
    const states: InvocationState[] = [
      'starting',
      'running',
      'cancelling',
      'quarantined',
      'success',
      'failed',
      'terminated',
    ]
    const validTimestamp = (value: unknown): value is string =>
      typeof value === 'string' && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value
    const hasProcessField =
      record.pid !== undefined ||
      record.pgid !== undefined ||
      record.sid !== undefined ||
      record.startToken !== undefined
    const validStartingOwnership =
      Number.isSafeInteger(record.pid) &&
      record.pid! > 1 &&
      typeof record.startToken === 'string' &&
      record.startToken.length > 0 &&
      (record.pgid === undefined || (Number.isSafeInteger(record.pgid) && record.pgid > 1)) &&
      (record.sid === undefined || (Number.isSafeInteger(record.sid) && record.sid > 1))
    const ownsProcess =
      Number.isSafeInteger(record.pid) &&
      record.pid! > 1 &&
      Number.isSafeInteger(record.pgid) &&
      record.pgid! > 1 &&
      Number.isSafeInteger(record.sid) &&
      record.sid! > 1 &&
      typeof record.startToken === 'string' &&
      record.startToken.length > 0
    const terminal = ['success', 'failed', 'terminated'].includes(record.state)
    const partialStartingHistory =
      record.state === 'terminated' &&
      record.priorState === 'starting' &&
      record.pgid === undefined &&
      record.sid === undefined
    if (
      record.version !== 1 ||
      record.invocationIdHash !== key ||
      !/^[a-f0-9]{64}$/.test(key) ||
      !Number.isSafeInteger(record.generation) ||
      record.generation < 0 ||
      typeof record.commandDigest !== 'string' ||
      record.commandDigest.length === 0 ||
      !states.includes(record.state) ||
      (record.priorState !== undefined && !states.includes(record.priorState)) ||
      !validTimestamp(record.startedAt) ||
      (hasProcessField &&
        (['starting', 'quarantined'].includes(record.state) || partialStartingHistory) &&
        !validStartingOwnership) ||
      (hasProcessField &&
        !['starting', 'quarantined'].includes(record.state) &&
        !partialStartingHistory &&
        !ownsProcess) ||
      (['running', 'cancelling'].includes(record.state) && !ownsProcess) ||
      (record.state === 'cancelling' &&
        (!validTimestamp(record.cancelRequestedAt) ||
          typeof record.cancelReason !== 'string' ||
          !record.cancelReason)) ||
      (record.state === 'quarantined' &&
        (!validTimestamp(record.quarantinedAt) || typeof record.reasonCode !== 'string' || !record.reasonCode)) ||
      (terminal && !validTimestamp(record.terminalAt))
    ) {
      throw new Error('INVALID_INVOCATION_RECORD')
    }
    return record
  }
  private async quarantine(key: string, record: BashInvocationRecord | undefined, reasonCode: string): Promise<void> {
    if (!record) {
      const quarantineDir = join(this.options.runtimeDir, 'quarantine')
      await mkdir(quarantineDir, { recursive: true, mode: 0o700 })
      for (const source of [this.path(key), this.legacyPath(key)]) {
        try {
          await rename(source, join(quarantineDir, `${key}.${this.now().getTime()}.json`))
          break
        } catch {
          /* try the other layout */
        }
      }
    }
    const marker: BashInvocationRecord = {
      version: 1,
      invocationIdHash: key,
      generation: record?.generation ?? 0,
      commandDigest: record?.commandDigest ?? createHash('sha256').update(key).digest('hex'),
      state: 'quarantined',
      priorState: record?.state,
      startedAt: record?.startedAt ?? this.now().toISOString(),
      quarantinedAt: this.now().toISOString(),
      reasonCode,
      pid: record?.pid,
      pgid: record?.pgid,
      sid: record?.sid,
      startToken: record?.startToken,
    }
    await this.write(key, marker)
  }
  private async migrateLegacyBatch(
    report?: { reconciled: string[]; quarantined: string[] },
    reconcileUnresolved = false
  ): Promise<number> {
    const processKey = async (key: string, legacy: boolean) => {
      try {
        await this.lock(key, async () => {
          let record: BashInvocationRecord | undefined
          try {
            record = await this.readValidated(key)
            if (!record) return
            if (['success', 'failed', 'terminated'].includes(record.state)) {
              await this.archiveTerminal(key, record)
              return
            }
            if (legacy && (!reconcileUnresolved || (record.state === 'quarantined' && !record.pid))) {
              await this.write(key, record)
              await unlink(this.legacyPath(key))
              return
            }
            if (!reconcileUnresolved || (record.state === 'quarantined' && !record.pid)) return
            await this.options.reconcile(record)
            record.priorState = record.state
            record.state = 'terminated'
            record.terminalAt = this.now().toISOString()
            await this.archiveTerminal(key, record)
            report?.reconciled.push(key)
          } catch {
            await this.quarantine(key, record, 'RECONCILIATION_AMBIGUOUS')
            report?.quarantined.push(key)
          }
        })
      } catch {
        if (report && !report.quarantined.includes(key)) report.quarantined.push(key)
      }
    }
    if (reconcileUnresolved) {
      const activeDir = join(this.options.runtimeDir, 'active')
      await mkdir(activeDir, { recursive: true, mode: 0o700 })
      for (const file of (await readdir(activeDir)).filter((name) => name.endsWith('.json'))) {
        await processKey(file.slice(0, -5), false)
      }
    }
    const files: string[] = []
    const limit = this.options.legacyMigrationBatchSize ?? 200
    let inspected = 0
    const directory = await opendir(this.options.runtimeDir)
    for await (const entry of directory) {
      inspected += 1
      if (entry.isFile() && entry.name.endsWith('.json')) files.push(entry.name)
      else if (!entry.isDirectory()) {
        const quarantineDir = join(this.options.runtimeDir, 'quarantine')
        await mkdir(quarantineDir, { recursive: true, mode: 0o700 })
        try {
          await rename(join(this.options.runtimeDir, entry.name), join(quarantineDir, `legacy.${randomUUID()}`))
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
      }
      if (files.length >= limit || inspected >= limit + 8) break
    }
    this.options.onLegacyBatch?.(inspected)
    for (const file of files) await processKey(file.slice(0, -5), true)
    return files.length
  }
  private async maybePrune(): Promise<void> {
    await mkdir(this.options.runtimeDir, { recursive: true, mode: 0o700 })
    this.maintenanceOperations += 1
    const interval = this.options.pruneEveryOperations ?? 100
    if (this.maintenanceOperations % interval === 0) {
      await this.migrateLegacyBatch()
      await this.pruneTerminalRecords()
      return
    }
    const threshold = this.options.pruneAtRecordCount ?? (this.options.maxTerminalRecords ?? 2000) + 200
    await mkdir(this.terminalDir(), { recursive: true, mode: 0o700 })
    const count = (await readdir(this.terminalDir())).filter((name) => name.endsWith('.json')).length
    if (count >= threshold) {
      await this.migrateLegacyBatch()
      await this.pruneTerminalRecords()
    }
  }
  async pruneTerminalRecords(): Promise<number> {
    await mkdir(this.terminalDir(), { recursive: true, mode: 0o700 })
    const records = (await readdir(this.terminalDir()))
      .map((file) => {
        const match = /^([a-f0-9]{64})\.(\d+)\.(\d+)\.json$/.exec(file)
        if (!match) return undefined
        return { file, key: match[1]!, generation: Number(match[2]), terminalTime: Number(match[3]) }
      })
      .filter(
        (record): record is { file: string; key: string; generation: number; terminalTime: number } =>
          record !== undefined &&
          Number.isSafeInteger(record.generation) &&
          record.generation >= 0 &&
          Number.isSafeInteger(record.terminalTime)
      )
      .sort((a, b) => b.terminalTime - a.terminalTime || b.generation - a.generation || a.key.localeCompare(b.key))
    const max = this.options.maxTerminalRecords ?? 2000
    const min = this.options.minRecentTerminalRecords ?? 200
    const cutoff = this.now().getTime() - (this.options.terminalRetentionMs ?? 7 * 24 * 60 * 60 * 1000)
    const doomed = records.filter(({ terminalTime }, index) => index >= min && (index >= max || terminalTime < cutoff))
    let pruned = 0
    for (const { file, key, generation } of doomed) {
      const path = join(this.terminalDir(), file)
      await this.options.beforeTerminalUnlink?.(path)
      try {
        await (this.options.unlink ?? unlink)(path)
        pruned += 1
        await this.lock(key, async () => {
          const active = await this.readValidated(key)
          const latest = await this.readGeneration(key)
          if (!active && latest?.generation === generation) {
            try {
              await unlink(this.generationPath(key))
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
            }
          }
        })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
        await this.lock(key, async () => {
          await this.quarantine(key, await this.readValidated(key), 'PRUNE_UNLINK_FAILED')
        })
      }
    }
    return pruned
  }
  private path(key: string) {
    return join(this.options.runtimeDir, 'active', `${key}.json`)
  }
  private legacyPath(key: string) {
    return join(this.options.runtimeDir, `${key}.json`)
  }
  private terminalDir() {
    return join(this.options.runtimeDir, 'terminal')
  }
  private generationPath(key: string) {
    return join(this.options.runtimeDir, 'generations', `${key}.json`)
  }
  private terminalPath(key: string, generation: number, terminalAt: string) {
    return join(this.terminalDir(), `${key}.${generation}.${Date.parse(terminalAt)}.json`)
  }
  private async readGeneration(key: string): Promise<BashInvocationRecord | undefined> {
    try {
      return this.validateRecord(
        key,
        JSON.parse(await readFile(this.generationPath(key), 'utf8')) as BashInvocationRecord
      )
    } catch (error: any) {
      if (error?.code === 'ENOENT') return undefined
      throw error
    }
  }
  private async read(key: string): Promise<BashInvocationRecord | undefined> {
    for (const path of [this.path(key), this.legacyPath(key)]) {
      try {
        return JSON.parse(await readFile(path, 'utf8')) as BashInvocationRecord
      } catch (error: any) {
        if (error?.code !== 'ENOENT') throw error
      }
    }
    return undefined
  }
  private async write(key: string, record: BashInvocationRecord): Promise<void> {
    await this.atomicWrite(this.path(key), record)
  }
  private async withStagedRecord(
    path: string,
    record: BashInvocationRecord,
    publish: (temp: string) => Promise<void>
  ): Promise<void> {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    const temp = `${path}.${randomUUID()}.tmp`
    try {
      const file = await open(temp, 'wx', 0o600)
      try {
        const contents = JSON.stringify(record)
        if (this.options.writeRecord) await this.options.writeRecord(file, contents)
        else await file.writeFile(contents)
        await file.sync()
      } finally {
        await file.close()
      }
      await publish(temp)
    } finally {
      await unlink(temp).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error
      })
    }
  }
  private async atomicWrite(path: string, record: BashInvocationRecord): Promise<void> {
    await this.withStagedRecord(path, record, (temp) => rename(temp, path))
  }
  private async writeImmutable(path: string, record: BashInvocationRecord): Promise<void> {
    await this.withStagedRecord(path, record, async (temp) => {
      try {
        // Publish only a fully written record, without replacing an existing
        // generation. A partial ENOSPC write must never become immutable proof.
        await link(temp, path)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        const existing = JSON.parse(await readFile(path, 'utf8')) as BashInvocationRecord
        if (JSON.stringify(existing) !== JSON.stringify(record)) throw new Error('TERMINAL_GENERATION_CONFLICT')
      }
    })
  }
  private async archiveTerminal(key: string, record: BashInvocationRecord): Promise<void> {
    this.validateRecord(key, record)
    await this.writeImmutable(this.terminalPath(key, record.generation, record.terminalAt!), record)
    await this.atomicWrite(this.generationPath(key), record)
    for (const path of [this.path(key), this.legacyPath(key)]) {
      try {
        await unlink(path)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
  }
}
