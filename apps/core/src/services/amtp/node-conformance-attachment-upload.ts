import { createHash } from 'node:crypto'
import { basename, join } from 'node:path'
import { readFile, readdir, rm } from 'node:fs/promises'
import { amtpNodeCommand } from './node-conformance-command'
import { lastAmtpUploadPhase, runFileCapturedProcess } from './node-conformance-process'
import { openNodeConformanceDb } from './node-conformance-sqlite'

interface AttachmentRow {
  id: string
  filename: string
  content_type: string
  byte_size: number
  sha256: string
  storage_path: string
}

export interface UploadPremise {
  filename: string
  byteSize: number
  sha256: string
  matchingRows: AttachmentRow[]
  blobs: string[]
  temporaryBlobs: string[]
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

async function names(path: string): Promise<string[]> {
  return (await readdir(path).catch(() => [])).sort()
}

function rowsForFilename(home: string, filename: string): AttachmentRow[] {
  const sqlite = openNodeConformanceDb(home, { readonly: true })
  try {
    return sqlite
      .query<AttachmentRow, [string]>(
        `SELECT id, filename, content_type, byte_size, sha256, storage_path FROM attachments WHERE direction = 'out' AND filename = ?`
      )
      .all(filename)
  } finally {
    sqlite.close()
  }
}

export async function inspectUploadPremise(options: {
  home: string
  filePath: string
  expectedBytes: Uint8Array
}): Promise<UploadPremise> {
  const sourceBytes = await readFile(options.filePath)
  if (!sourceBytes.equals(Buffer.from(options.expectedBytes))) {
    throw new Error('attachment-persistence-integrity: source bytes differ from parent fixture')
  }
  const filename = basename(options.filePath)
  const matchingRows = rowsForFilename(options.home, filename)
  if (matchingRows.length !== 0) {
    throw new Error(`attachment-persistence-integrity: target filename already has ${matchingRows.length} row(s)`)
  }
  return {
    filename,
    byteSize: sourceBytes.byteLength,
    sha256: sha256Hex(sourceBytes),
    matchingRows,
    blobs: await names(join(options.home, 'blobs')),
    temporaryBlobs: await names(join(options.home, 'blobs', 'tmp')),
  }
}

async function cleanupUploadIdentity(home: string, attachmentId: string): Promise<void> {
  const sqlite = openNodeConformanceDb(home)
  let storagePath: string | undefined
  try {
    const row = sqlite
      .query<{ storage_path: string }, [string]>(
        `SELECT storage_path FROM attachments WHERE id = ? AND direction = 'out'`
      )
      .get(attachmentId)
    storagePath = row?.storage_path
    sqlite.run(`DELETE FROM attachments WHERE id = ? AND direction = 'out'`, [attachmentId])
  } finally {
    sqlite.close()
  }
  if (storagePath) await rm(join(home, 'blobs', storagePath), { force: true })
}

async function reconcileFailedUpload(home: string, premise: UploadPremise): Promise<void> {
  const baselineIds = new Set(premise.matchingRows.map(({ id }) => id))
  const candidates = rowsForFilename(home, premise.filename).filter(
    (row) =>
      !baselineIds.has(row.id) &&
      row.byte_size === premise.byteSize &&
      row.sha256 === premise.sha256 &&
      row.storage_path === row.id
  )
  if (candidates.length === 0) return
  if (candidates.length !== 1) {
    throw new Error(`attachment-cleanup-attribution-ambiguous: matchingRows=${candidates.length}`)
  }
  await cleanupUploadIdentity(home, candidates[0].id)
}

interface UploadResult {
  attachmentId: string
  filename: string
  contentType: string
  byteSize: number
  sha256: string
}

export function readNodeOutboxEnvelope(home: string, outboxId: string): unknown {
  const sqlite = openNodeConformanceDb(home, { readonly: true })
  try {
    const row = sqlite
      .query<{ envelope_json: string }, [string]>('SELECT envelope_json FROM outbox WHERE id = ?')
      .get(outboxId)
    if (!row) throw new Error(`missing node outbox row ${outboxId}`)
    return JSON.parse(row.envelope_json) as unknown
  } finally {
    sqlite.close()
  }
}

export interface VerifiedUpload extends UploadResult {
  dispose(outboxId?: string): Promise<void>
}

function parseUpload(value: string): UploadResult | undefined {
  try {
    const parsed: unknown = JSON.parse(value)
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      typeof (parsed as UploadResult).attachmentId !== 'string' ||
      typeof (parsed as UploadResult).filename !== 'string' ||
      typeof (parsed as UploadResult).contentType !== 'string' ||
      typeof (parsed as UploadResult).byteSize !== 'number' ||
      typeof (parsed as UploadResult).sha256 !== 'string'
    ) {
      return undefined
    }
    return parsed as UploadResult
  } catch {
    return undefined
  }
}

interface UploadDependencies {
  runProcess: typeof runFileCapturedProcess
}

const uploadDependencies: UploadDependencies = { runProcess: runFileCapturedProcess }

export async function uploadNodeAttachment(
  options: {
    home: string
    captureDir: string
    nodeEntry: string
    filePath: string
    expectedBytes: Uint8Array
    timeoutMs: number
    diagnostics?: () => string | Promise<string>
  },
  dependencies: UploadDependencies = uploadDependencies
): Promise<VerifiedUpload> {
  const premise = await inspectUploadPremise(options)
  let result: Awaited<ReturnType<typeof dependencies.runProcess>>
  try {
    result = await dependencies.runProcess(
      amtpNodeCommand(process.execPath, options.nodeEntry, [
        '--home',
        options.home,
        '--json',
        'attach',
        'upload',
        options.filePath,
      ]),
      {
        phase: 'amtp-cli:attach-upload',
        timeoutMs: options.timeoutMs,
        captureDir: options.captureDir,
        env: { AMTP_CONFORMANCE_TRACE_UPLOAD: '1' },
        terminalOutput: (stdout) => parseUpload(stdout) !== undefined,
        diagnostics: async ({ stderr }) => {
          const supplied = await options.diagnostics?.()
          return `lastUploadPhase=${lastAmtpUploadPhase(stderr) ?? 'none'}${supplied ? `; ${supplied}` : ''}`
        },
      }
    )
  } catch (error) {
    await reconcileFailedUpload(options.home, premise)
    throw error
  }
  const upload = parseUpload(result.stdout)
  if (result.exitCode !== 0) {
    if (upload) await cleanupUploadIdentity(options.home, upload.attachmentId)
    throw new Error(`amtp upload failed with exit ${result.exitCode}`)
  }
  if (!upload) throw new Error('attachment-persistence-integrity: invalid terminal upload JSON')

  const rows = rowsForFilename(options.home, premise.filename)
  const row = rows.find((candidate) => candidate.id === upload.attachmentId)
  const blobPath = join(options.home, 'blobs', upload.attachmentId)
  const blobBytes = await readFile(blobPath).catch(() => undefined)
  const temporaryBlobs = await names(join(options.home, 'blobs', 'tmp'))
  const expected = Buffer.from(options.expectedBytes)
  const exact =
    rows.length === 1 &&
    row !== undefined &&
    row.storage_path === upload.attachmentId &&
    upload.filename === premise.filename &&
    row.filename === upload.filename &&
    row.content_type === upload.contentType &&
    row.byte_size === upload.byteSize &&
    upload.byteSize === premise.byteSize &&
    row.sha256 === upload.sha256 &&
    upload.sha256 === premise.sha256 &&
    blobBytes?.equals(expected) === true &&
    temporaryBlobs.join('\0') === premise.temporaryBlobs.join('\0')
  if (!exact) {
    await cleanupUploadIdentity(options.home, upload.attachmentId)
    throw new Error('attachment-persistence-integrity: row, blob, or terminal identity mismatch')
  }

  let disposed = false
  return {
    ...upload,
    async dispose(outboxId?: string) {
      if (disposed) return
      const sqlite = openNodeConformanceDb(options.home)
      try {
        if (outboxId) sqlite.run('DELETE FROM outbox WHERE id = ?', [outboxId])
        sqlite.run(`DELETE FROM attachments WHERE id = ? AND direction = 'out'`, [upload.attachmentId])
      } finally {
        sqlite.close()
      }
      await rm(blobPath, { force: true })
      if (rowsForFilename(options.home, premise.filename).some((candidate) => candidate.id === upload.attachmentId)) {
        throw new Error('attachment cleanup omission: outbound row remains')
      }
      if (
        await readFile(blobPath).then(
          () => true,
          () => false
        )
      ) {
        throw new Error('attachment cleanup omission: final blob remains')
      }
      const remainingBlobs = await names(join(options.home, 'blobs'))
      if (remainingBlobs.join('\0') !== premise.blobs.join('\0')) {
        throw new Error('attachment cleanup isolation: baseline blob fingerprint changed')
      }
      const remainingTemporaryBlobs = await names(join(options.home, 'blobs', 'tmp'))
      if (remainingTemporaryBlobs.join('\0') !== premise.temporaryBlobs.join('\0')) {
        throw new Error('attachment cleanup omission: temporary blob fingerprint changed')
      }
      disposed = true
    },
  }
}
