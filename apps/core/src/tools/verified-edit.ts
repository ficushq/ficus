import { createHash } from 'crypto'
import { resolve } from 'path'
import {
  createEditTool,
  generateDiffString,
  generateUnifiedPatch,
  withFileMutationQueue,
} from '@earendil-works/pi-coding-agent'
import type { FileIdentity, VerifiedWriteResponse } from '../services/sandbox/client/http-client'

export type ExactEdit = {
  oldText: string
  newText: string
}

export type AuthorizedRange = {
  editIndex: number
  start: number
  end: number
  replacement: Buffer
}

export type VerifiedEditPlan = {
  original: Buffer
  result: Buffer
  ranges: AuthorizedRange[]
  originalBytes: number
  resultBytes: number
  originalSha256: string
  resultSha256: string
}

export type VerifiedEditPlannerOptions = {
  /** Injection seam for integrity-failure tests; production uses byte-slice assembly. */
  assemble?: (original: Buffer, ranges: AuthorizedRange[]) => Buffer
}

const sha256 = (value: Buffer) => createHash('sha256').update(value).digest('hex')

function integrityError(category: string): Error {
  return new Error(`Edit integrity check failed before write: ${category}; original file was not modified`)
}

function assertValidUtf8(original: Buffer): void {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(original)
  } catch {
    throw integrityError('file is not valid UTF-8')
  }
}

function newlineVariants(value: string): string[] {
  const variants = [value]
  if (value.includes('\n') && !value.includes('\r\n')) variants.push(value.replaceAll('\n', '\r\n'))
  return variants
}

function usesUniformCrlf(value: Buffer): boolean {
  let sawCrlf = false
  for (let index = 0; index < value.byteLength; index += 1) {
    if (value[index] !== 0x0a) continue
    if (index === 0 || value[index - 1] !== 0x0d) return false
    sawCrlf = true
  }
  return sawCrlf
}

function findUniqueByteRange(original: Buffer, edit: ExactEdit, editIndex: number): AuthorizedRange {
  if (edit.oldText.length === 0) throw integrityError(`edit ${editIndex + 1} oldText is empty`)

  const candidates: Array<{ start: number; end: number; crlfMatch: boolean }> = []
  for (const variant of newlineVariants(edit.oldText)) {
    const needle = Buffer.from(variant, 'utf8')
    let start = original.indexOf(needle)
    while (start >= 0) {
      if (!candidates.some((candidate) => candidate.start === start && candidate.end === start + needle.byteLength)) {
        candidates.push({ start, end: start + needle.byteLength, crlfMatch: variant !== edit.oldText })
      }
      start = original.indexOf(needle, start + 1)
    }
  }
  if (candidates.length === 0) throw integrityError(`edit ${editIndex + 1} match was not found`)
  if (candidates.length > 1) {
    throw integrityError(`edit ${editIndex + 1} match is ambiguous; expected a unique occurrence`)
  }

  const candidate = candidates[0]
  const normalizeReplacement = (candidate.crlfMatch || usesUniformCrlf(original)) && !edit.newText.includes('\r\n')
  return {
    editIndex,
    start: candidate.start,
    end: candidate.end,
    replacement: Buffer.from(normalizeReplacement ? edit.newText.replaceAll('\n', '\r\n') : edit.newText, 'utf8'),
  }
}

function assertNonOverlapping(ranges: AuthorizedRange[]): void {
  for (let index = 1; index < ranges.length; index += 1) {
    if (ranges[index].start < ranges[index - 1].end) {
      throw integrityError(`edits ${ranges[index - 1].editIndex + 1} and ${ranges[index].editIndex + 1} overlap`)
    }
  }
}

function assembleFromOriginalSlices(original: Buffer, ranges: AuthorizedRange[]): Buffer {
  const chunks: Buffer[] = []
  let offset = 0
  for (const range of ranges) {
    chunks.push(original.subarray(offset, range.start), range.replacement)
    offset = range.end
  }
  chunks.push(original.subarray(offset))
  return Buffer.concat(chunks)
}

function expectedResultLength(original: Buffer, ranges: AuthorizedRange[]): number {
  return ranges.reduce(
    (length, range) => length + range.replacement.byteLength - (range.end - range.start),
    original.byteLength
  )
}

function verifyUnchangedRegions(original: Buffer, result: Buffer, ranges: AuthorizedRange[]): void {
  let originalOffset = 0
  let resultOffset = 0

  for (const range of ranges) {
    const unchangedLength = range.start - originalOffset
    if (
      Buffer.compare(
        original.subarray(originalOffset, range.start),
        result.subarray(resultOffset, resultOffset + unchangedLength)
      ) !== 0
    ) {
      throw integrityError('an unchanged prefix or interstitial region was altered')
    }
    const replacementStart = resultOffset + unchangedLength
    if (
      Buffer.compare(
        range.replacement,
        result.subarray(replacementStart, replacementStart + range.replacement.byteLength)
      ) !== 0
    ) {
      throw integrityError(`edit ${range.editIndex + 1} replacement bytes were altered`)
    }
    resultOffset = replacementStart + range.replacement.byteLength
    originalOffset = range.end
  }

  const suffix = original.subarray(originalOffset)
  if (Buffer.compare(suffix, result.subarray(resultOffset, resultOffset + suffix.byteLength)) !== 0) {
    throw integrityError('the unchanged suffix was altered')
  }
}

export function planVerifiedEdit(
  original: Buffer,
  edits: ExactEdit[],
  _path: string,
  options: VerifiedEditPlannerOptions = {}
): VerifiedEditPlan {
  assertValidUtf8(original)
  if (edits.length === 0) throw integrityError('at least one edit is required')

  const ranges = edits
    .map((edit, editIndex) => findUniqueByteRange(original, edit, editIndex))
    .sort((left, right) => left.start - right.start)
  assertNonOverlapping(ranges)

  const result = options.assemble
    ? options.assemble(
        Buffer.from(original),
        ranges.map((range) => ({ ...range, replacement: Buffer.from(range.replacement) }))
      )
    : assembleFromOriginalSlices(original, ranges)
  const expectedBytes = expectedResultLength(original, ranges)
  if (result.byteLength !== expectedBytes) {
    throw integrityError(`result length mismatch (expected ${expectedBytes} bytes, received ${result.byteLength})`)
  }
  verifyUnchangedRegions(original, result, ranges)
  if (Buffer.compare(original, result) === 0) throw integrityError('edit result is identical; no change was requested')

  return {
    original,
    result,
    ranges,
    originalBytes: original.byteLength,
    resultBytes: result.byteLength,
    originalSha256: sha256(original),
    resultSha256: sha256(result),
  }
}

export interface VerifiedEditOperations {
  access(path: string): Promise<void>
  readFile(path: string): Promise<Buffer>
  commitFile(
    path: string,
    result: Buffer,
    identity: { original: FileIdentity; result: FileIdentity }
  ): Promise<VerifiedWriteResponse>
}

type VerifiedEditInput = {
  path: string
  edits?: ExactEdit[] | string
  oldText?: string
  newText?: string
}

function normalizeEdits(input: VerifiedEditInput): ExactEdit[] {
  let edits: unknown = input.edits
  if (typeof edits === 'string') {
    try {
      edits = JSON.parse(edits)
    } catch {
      throw integrityError('edits must be a JSON array of replacements')
    }
  }
  const normalized = Array.isArray(edits) ? [...edits] : []
  if (typeof input.oldText === 'string' && typeof input.newText === 'string') {
    normalized.push({ oldText: input.oldText, newText: input.newText })
  }
  if (normalized.length === 0) throw integrityError('at least one edit is required')
  for (const edit of normalized) {
    if (
      typeof edit !== 'object' ||
      edit === null ||
      typeof (edit as ExactEdit).oldText !== 'string' ||
      typeof (edit as ExactEdit).newText !== 'string'
    ) {
      throw integrityError('each edit requires string oldText and newText')
    }
  }
  return normalized as ExactEdit[]
}

function executorIntegrityError(category: string): Error {
  return new Error(`Edit integrity check failed: ${category}; success was not reported`)
}

export function createVerifiedEditTool(cwd: string, operations: VerifiedEditOperations) {
  const presentation = createEditTool(cwd, {
    operations: {
      access: operations.access,
      readFile: operations.readFile,
      writeFile: async () => {
        throw new Error('Verified edit presentation must not perform a legacy write')
      },
    },
  })
  return {
    ...presentation,
    async execute(_toolCallId: string, input: unknown, signal?: AbortSignal) {
      if (typeof input !== 'object' || input === null || typeof (input as VerifiedEditInput).path !== 'string') {
        throw integrityError('edit input requires a string path')
      }
      const verifiedInput = input as VerifiedEditInput
      const edits = normalizeEdits(verifiedInput)
      const absolutePath = resolve(cwd, verifiedInput.path)
      return withFileMutationQueue(absolutePath, async () => {
        const throwIfAborted = () => {
          if (signal?.aborted) throw new Error('Operation aborted')
        }
        const throwIfAbortedAfterCommit = () => {
          if (signal?.aborted) {
            throw executorIntegrityError('operation aborted after commit settled; candidate may have been published')
          }
        }

        throwIfAborted()
        await operations.access(absolutePath)
        throwIfAborted()
        const original = await operations.readFile(absolutePath)
        throwIfAborted()
        const planned = planVerifiedEdit(original, edits, absolutePath)
        const originalIdentity = { bytes: planned.originalBytes, sha256: planned.originalSha256 }
        const resultIdentity = { bytes: planned.resultBytes, sha256: planned.resultSha256 }
        const response = await operations.commitFile(absolutePath, planned.result, {
          original: originalIdentity,
          result: resultIdentity,
        })
        throwIfAbortedAfterCommit()
        if (response.bytesWritten !== resultIdentity.bytes || response.sha256 !== resultIdentity.sha256) {
          throw executorIntegrityError('commit response identity mismatch; candidate may have been published')
        }
        const readback = await operations.readFile(absolutePath)
        throwIfAbortedAfterCommit()
        if (readback.byteLength !== resultIdentity.bytes || sha256(readback) !== resultIdentity.sha256) {
          throw executorIntegrityError('final readback identity mismatch; candidate may have been published')
        }

        const originalText = original.toString('utf8')
        const resultText = planned.result.toString('utf8')
        const diffResult = generateDiffString(originalText, resultText)
        const patch = generateUnifiedPatch(verifiedInput.path, originalText, resultText)
        return {
          content: [
            {
              type: 'text' as const,
              text: `Successfully replaced ${edits.length} block(s) in ${verifiedInput.path} (${planned.originalBytes} -> ${planned.resultBytes} bytes; byte integrity verified).`,
            },
          ],
          details: {
            originalBytes: planned.originalBytes,
            resultBytes: planned.resultBytes,
            originalSha256: planned.originalSha256,
            resultSha256: planned.resultSha256,
            replacementCount: edits.length,
            diff: diffResult.diff,
            patch,
            firstLine: diffResult.firstChangedLine,
            firstChangedLine: diffResult.firstChangedLine,
          },
        }
      })
    },
  }
}
