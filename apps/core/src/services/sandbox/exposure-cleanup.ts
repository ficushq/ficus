/** Retirement-only cleanup. Never reads the operator Secret Store or copies exposure values. */
import { lstatSync, readdirSync, rmSync, renameSync, createReadStream, createWriteStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { createGunzip, createGzip } from 'node:zlib'
import { extract, pack } from 'tar-stream'
import { join } from 'node:path'
import { and, eq, lte, ne, or, sql } from 'drizzle-orm'
import { db, agents, machineBoxes, sandboxExposureCleanup, squads } from '../../db'
import { getHomeDir } from '../../lib/utils/home'
import { createLogger } from '../../lib/infra/logger'
import { createPeriodicRunner, type PeriodicRunner } from '../../lib/infra/PeriodicRunner'
import { prepareWorkspaceDotDir, WorkspaceDotDirConflictError } from '../workspace/dot-dir'
import { regenerateEnvFileForSquadStrict } from '../squad/env'
import { isVmRuntime } from './runtime'
import { isCanonicalSquadId } from '../squad/workspace'

const log = createLogger('exposure-cleanup')
const RETRY_MS = 60_000
export type CleanupTarget = Pick<
  typeof sandboxExposureCleanup.$inferSelect,
  'targetId' | 'kind' | 'sourceId' | 'squadId'
>
export type CleanupStatus = Pick<typeof sandboxExposureCleanup.$inferSelect, 'status' | 'reason' | 'updatedAt'> & {
  targets?: Array<Pick<typeof sandboxExposureCleanup.$inferSelect, 'targetId' | 'status' | 'reason' | 'updatedAt'>>
}
type CleanupPatch = CleanupStatus & { nextAttemptAt: Date }

/** Do not follow an agent-controlled settings directory (or private-root symlink). */
export async function cleanLegacyPrivateDirectory(root: string): Promise<void> {
  try {
    const stat = lstatSync(root)
    if (stat.isSymbolicLink() || !stat.isDirectory())
      throw new WorkspaceDotDirConflictError(root, 'ficus-not-a-directory')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  prepareWorkspaceDotDir(root)
  rmSync(join(root, '.ficus', 'agent-secrets.env'), { force: true })
}

/** Stream-filter managed retired archive members without extraction or platform tar dependencies. */
export async function cleanLegacyArchive(path: string): Promise<void> {
  const temporary = `${path}.cleanup-${crypto.randomUUID()}`
  const reader = extract()
  const writer = pack()
  const signal = AbortSignal.timeout(120_000)
  reader.on('entry', (header, entry, next) => {
    const name = header.name.replace(/^\.\//, '')
    if (/(^|\/)\.ficus\/agent-secrets\.env$/.test(name) || /(^|\/)workspace\/\.ficus\/\.env$/.test(name)) {
      entry.on('end', next)
      entry.resume()
    } else {
      // Metadata and user files pass through unchanged. Never resolve archive paths on the host.
      const output = writer.entry(header)
      pipeline(entry, output, { signal }).then(
        () => next(),
        (error) => reader.destroy(error)
      )
    }
  })
  reader.on('finish', () => writer.finalize())
  try {
    await Promise.all([
      pipeline(createReadStream(path), createGunzip(), reader, { signal }),
      pipeline(writer, createGzip(), createWriteStream(temporary, { flags: 'wx', mode: 0o600 }), { signal }),
    ])
    renameSync(temporary, path)
  } finally {
    reader.destroy()
    writer.destroy()
    rmSync(temporary, { force: true })
  }
}

/** Acknowledgement is all-or-nothing. Persist retry time even on known conflicts. */
export async function runCleanupTarget(
  target: CleanupTarget,
  deps: {
    clean(): Promise<boolean>
    save(patch: CleanupPatch): Promise<void>
    now?: () => Date
    log?: (message: string) => void
  }
): Promise<void> {
  let status: CleanupPatch['status'] = 'done'
  let reason: string | null = null
  try {
    if (!(await deps.clean())) {
      status = 'pending'
      reason = 'Sandbox unreachable; automatic cleanup will retry.'
    }
  } catch (error) {
    status = 'failed'
    // Remote stderr can contain user data: never persist it into a public status payload.
    reason =
      error instanceof WorkspaceDotDirConflictError
        ? error.message
        : 'Managed file cleanup failed; automatic cleanup will retry. Check settings directory permissions and runtime availability.'
  }
  const now = deps.now?.() ?? new Date()
  await deps.save({ status, reason, updatedAt: now, nextAttemptAt: new Date(now.getTime() + RETRY_MS) })
  const report = deps.log ?? ((message: string) => log.info(message))
  report(`Exposure cleanup ${target.targetId}: ${status}${reason ? ` — ${reason}` : ''}`)
}

function directories(root: string): string[] {
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory() || e.isSymbolicLink())
      .map((e) => e.name)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

/** Discover independently of sandbox ensure, including archived squads and private archives. */
async function discoverTargets(): Promise<CleanupTarget[]> {
  const result: CleanupTarget[] = []
  for (const squad of await db.select({ id: squads.id }).from(squads))
    result.push({ targetId: `squad:${squad.id}`, kind: 'squad', sourceId: squad.id, squadId: squad.id })
  for (const name of directories(join(getHomeDir(), 'private')))
    result.push({ targetId: `private:${name}`, kind: 'private', sourceId: name, squadId: null })
  for (const name of directories(join(getHomeDir(), 'private-archive')))
    result.push({ targetId: `archive:${name}`, kind: 'archive', sourceId: name, squadId: null })
  for (const box of await db.select({ id: machineBoxes.sandboxId }).from(machineBoxes))
    result.push(await vmTarget(box.id))
  return result
}

async function vmTarget(sandboxId: string): Promise<CleanupTarget> {
  let squadId: string | null = null
  if (sandboxId.startsWith('squad_') && isCanonicalSquadId(sandboxId.slice(6))) squadId = sandboxId.slice(6)
  else if (sandboxId.startsWith('agent_') && isCanonicalSquadId(sandboxId.slice(6))) {
    const [agent] = await db
      .select({ squadId: agents.squadId })
      .from(agents)
      .where(eq(agents.id, sandboxId.slice(6)))
    squadId = agent?.squadId ?? null
  } else if (sandboxId.startsWith('consultants_') && isCanonicalSquadId(sandboxId.slice('consultants_'.length)))
    squadId = sandboxId.slice('consultants_'.length)
  return { targetId: `vm:${sandboxId}`, kind: 'vm', sourceId: sandboxId, squadId }
}

async function cleanTarget(
  target: CleanupTarget,
  client?: import('./client/http-client').SandboxClient
): Promise<boolean> {
  switch (target.kind) {
    case 'squad':
      await regenerateEnvFileForSquadStrict(target.sourceId)
      return true
    case 'private':
      await cleanLegacyPrivateDirectory(join(getHomeDir(), 'private', target.sourceId))
      return true
    case 'archive': {
      const root = join(getHomeDir(), 'private-archive', target.sourceId)
      await cleanLegacyPrivateDirectory(root)
      try {
        const archive = join(root, 'private.tar.gz')
        const stat = lstatSync(archive)
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Invalid private archive')
        await cleanLegacyArchive(archive)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      return true
    }
    case 'vm': {
      const { cleanExposureFilesOnBox } = await import('./vm/file-sync')
      // Re-render for this attempt too; never push a stale host-side snapshot.
      if (target.squadId) await regenerateEnvFileForSquadStrict(target.squadId)
      return cleanExposureFilesOnBox(target.sourceId, target.squadId, client ? { getClient: async () => client } : {})
    }
  }
}

async function rememberTarget(target: CleanupTarget): Promise<void> {
  await db
    .insert(sandboxExposureCleanup)
    .values(target)
    .onConflictDoUpdate({
      target: sandboxExposureCleanup.targetId,
      set: {
        squadId: target.squadId,
        status: 'pending',
        reason: null,
        nextAttemptAt: new Date(),
        updatedAt: new Date(),
      },
      setWhere: sql`${sandboxExposureCleanup.squadId} IS DISTINCT FROM ${target.squadId}`,
    })
}
async function processTarget(
  target: CleanupTarget,
  client?: import('./client/http-client').SandboxClient,
  clean = () => cleanTarget(target, client)
): Promise<void> {
  await runCleanupTarget(target, {
    clean,
    save: async (patch) => {
      await db.update(sandboxExposureCleanup).set(patch).where(eq(sandboxExposureCleanup.targetId, target.targetId))
    },
  })
}

/** Bounded and serial: offline machines cannot fan out an unbounded SSH storm. */
export async function runExposureCleanupSweep(
  deps: {
    discover?: () => Promise<CleanupTarget[]>
    clean?: (target: CleanupTarget) => Promise<boolean>
  } = {}
): Promise<void> {
  for (const target of await (deps.discover ?? discoverTargets)()) await rememberTarget(target)
  const due = await db
    .select()
    .from(sandboxExposureCleanup)
    .where(and(ne(sandboxExposureCleanup.status, 'done'), lte(sandboxExposureCleanup.nextAttemptAt, new Date())))
    .orderBy(sandboxExposureCleanup.nextAttemptAt, sandboxExposureCleanup.targetId)
    .limit(25)
  for (const target of due) await processTarget(target, undefined, deps.clean ? () => deps.clean!(target) : undefined)
}

/** First-contact backstop. Failures are persisted, not an execution/terminal gate. */
export async function cleanupExposureOnContact(
  sandboxId: string,
  client?: import('./client/http-client').SandboxClient
): Promise<void> {
  try {
    const target = client
      ? await vmTarget(sandboxId)
      : {
          targetId: `private:${sandboxId}`,
          kind: 'private' as const,
          sourceId: sandboxId,
          squadId: null,
        }
    await rememberTarget(target)
    // Always repair on contact: old archives may have been restored since an earlier acknowledgement.
    await processTarget(target, client)
    if (!client) {
      const { squadId } = await vmTarget(sandboxId)
      if (squadId) {
        const squadTarget: CleanupTarget = { targetId: `squad:${squadId}`, sourceId: squadId, kind: 'squad', squadId }
        await rememberTarget(squadTarget)
        await processTarget(squadTarget)
      }
    }
  } catch {
    log.warn(`Could not record exposure cleanup for ${sandboxId}; startup/periodic sweep will retry`)
  }
}

export async function getExposureCleanupStatus(sandboxId: string, squadId?: string | null): Promise<CleanupStatus> {
  const primary = isVmRuntime()
    ? `vm:${sandboxId}`
    : sandboxId.startsWith('squad_')
      ? `squad:${sandboxId.slice(6)}`
      : `private:${sandboxId}`
  const ids = [...new Set([primary, ...(squadId ? [`squad:${squadId}`] : [])])]
  const rows = await db
    .select({
      targetId: sandboxExposureCleanup.targetId,
      status: sandboxExposureCleanup.status,
      reason: sandboxExposureCleanup.reason,
      updatedAt: sandboxExposureCleanup.updatedAt,
    })
    .from(sandboxExposureCleanup)
    .where(
      or(
        ...[...new Set([...ids, `private:${sandboxId}`, `vm:${sandboxId}`])].map((id) =>
          eq(sandboxExposureCleanup.targetId, id)
        ),
        and(
          eq(sandboxExposureCleanup.kind, 'archive'),
          sql`left(${sandboxExposureCleanup.sourceId}, ${sandboxId.length + 1}) = ${sandboxId + '-'}`
        )
      )
    )
  const outstanding = rows.find((row) => row.status === 'failed') ?? rows.find((row) => row.status === 'pending')
  if (outstanding)
    return { status: outstanding.status, reason: outstanding.reason, updatedAt: outstanding.updatedAt, targets: rows }
  if (ids.some((id) => !rows.some((row) => row.targetId === id)))
    return {
      status: 'pending',
      reason: 'Startup cleanup has not acknowledged this target yet.',
      updatedAt: new Date(0),
      targets: rows,
    }
  return { status: 'done', reason: null, updatedAt: rows[0].updatedAt, targets: rows }
}

let runner: PeriodicRunner | undefined
export function startExposureCleanup(): void {
  if (runner) return
  runner = createPeriodicRunner({
    name: 'exposure-retirement-cleanup',
    intervalMs: RETRY_MS,
    runImmediately: true,
    task: runExposureCleanupSweep,
  })
  runner.start()
}
export async function stopExposureCleanup(): Promise<void> {
  await runner?.stop()
  runner = undefined
}
