import { useCallback, useEffect, useRef, useState } from 'react'
import { useStableRef } from './useStableRef'
import { buildAgentAttachmentPath } from '@ficus/shared'
import { deleteAgentFile, uploadAgentFile } from '../api/agentFiles'
import {
  insertAttachmentReference,
  removeAttachmentReferences,
  repairAttachmentReference,
  type TextSelection,
} from '../lib/agentFileComposer'

/**
 * Where the caret belongs after adoption rewrote the text under it. The token
 * is replaced in place, so a caret BEFORE the edit does not move and a caret
 * after it shifts by the length delta — otherwise the user's cursor jumps to
 * the end of their half-typed sentence.
 */
export function adoptionCaret(before: string, after: string, caret?: number): number | undefined {
  if (caret == null) return undefined
  let common = 0
  while (common < before.length && common < after.length && before[common] === after[common]) common++
  if (caret <= common) return caret
  return Math.max(0, Math.min(after.length, caret + (after.length - before.length)))
}

export interface PendingAgentFile {
  id: string
  agentId: string
  file: File
  reference: string
  path: string
  canonicalReference?: string
  status: 'uploading' | 'done' | 'error'
  progress: number
  error?: string
}

export function useAgentFileAttachments(options: {
  agentId?: string
  getText: () => string
  /** Current caret offset, so adoption can keep it where the user left it. */
  getCaret?: () => number | undefined
  /**
   * Replace the composer text. `focus` is requested ONLY by explicit user
   * actions (attaching, removing a chip), which return the caret to the
   * composer; server-driven rewrites leave focus wherever the user is.
   */
  setText: (text: string, caret?: number, options?: { focus?: boolean }) => void
  uploadFile?: typeof uploadAgentFile
  deleteFile?: typeof deleteAgentFile
}) {
  const { agentId, uploadFile = uploadAgentFile, deleteFile = deleteAgentFile } = options
  const getTextRef = useStableRef(options.getText)
  const getCaretRef = useStableRef(options.getCaret ?? (() => undefined))
  const setTextRef = useStableRef(options.setText)
  const ownershipTransferRef = useRef(false)
  const [files, setFiles] = useState<PendingAgentFile[]>([])
  const filesRef = useRef(files)
  filesRef.current = files
  const controllers = useRef(new Map<string, AbortController>())
  const removed = useRef(new Set<string>())
  const deferredCleanup = useRef(new Map<string, PendingAgentFile>())

  useEffect(() => {
    return () => {
      for (const controller of controllers.current.values()) controller.abort()
      const owned = filesRef.current
      for (const file of owned) removed.current.add(file.id)
      controllers.current.clear()
      setFiles([])
      const original = getTextRef.current()
      let text = original
      for (const file of owned) {
        text = removeAttachmentReferences(text, file.reference)
        if (file.canonicalReference) text = removeAttachmentReferences(text, file.canonicalReference)
        if (ownershipTransferRef.current) deferredCleanup.current.set(file.id, file)
        else void deleteFile(file.agentId, file.id).catch(() => {})
      }
      if (text !== original) setTextRef.current(text)
    }
  }, [agentId, deleteFile, getTextRef, ownershipTransferRef, setTextRef])

  const performUpload = useCallback(
    async (pending: PendingAgentFile) => {
      const controller = new AbortController()
      controllers.current.set(pending.id, controller)
      setFiles((current) =>
        current.map((item) =>
          item.id === pending.id ? { ...item, status: 'uploading', progress: 0, error: undefined } : item
        )
      )
      try {
        const result = await uploadFile(pending.agentId, pending.id, pending.file, {
          signal: controller.signal,
          onProgress: (progress) =>
            setFiles((current) => current.map((item) => (item.id === pending.id ? { ...item, progress } : item))),
        })
        if (removed.current.has(pending.id)) return
        // Defence in depth behind uploadAgentFile's own body check: adopting a
        // missing path would rewrite the user's token to `@undefined` and mark
        // the chip done, so an unusable answer is a failure, not a path.
        if (typeof result.path !== 'string' || !result.path) {
          throw new Error('Upload failed (malformed response)')
        }
        const canonicalReference = `@${result.path}`
        // The provisional reference assumed the container layout; the server
        // answers with the path the file actually has on the active runtime
        // (host materialises under <HOME_DIR>/private/<sandboxId>). Adopt it:
        // only that path exists for the agent to open.
        if (result.path !== pending.path) {
          const text = getTextRef.current()
          const adopted = repairAttachmentReference(text, pending.reference, canonicalReference)
          if (adopted !== text) setTextRef.current(adopted, adoptionCaret(text, adopted, getCaretRef.current()))
        }
        setFiles((current) =>
          current.map((item) =>
            item.id === pending.id
              ? {
                  ...item,
                  status: 'done',
                  path: result.path,
                  // `reference` stays the PROVISIONAL spelling and
                  // `canonicalReference` holds the adopted one: cleanup removes
                  // both, so a provisional token that adoption did not replace
                  // (or that came back via an undo) is still stripped.
                  canonicalReference,
                  error: undefined,
                  progress: 1,
                }
              : item
          )
        )
      } catch (error) {
        if (controller.signal.aborted || removed.current.has(pending.id)) return
        setFiles((current) =>
          current.map((item) =>
            item.id === pending.id
              ? { ...item, status: 'error', error: error instanceof Error ? error.message : 'Upload failed' }
              : item
          )
        )
      } finally {
        controllers.current.delete(pending.id)
        if (removed.current.delete(pending.id)) {
          await deleteFile(pending.agentId, pending.id).catch(() => {})
        }
      }
    },
    [deleteFile, getCaretRef, getTextRef, setTextRef, uploadFile]
  )

  const addFiles = useCallback(
    (selectedFiles: File[], selection?: TextSelection) => {
      if (!agentId || selectedFiles.length === 0) return
      let text = getTextRef.current()
      let nextSelection = selection
      const pendingFiles: PendingAgentFile[] = []
      for (const file of selectedFiles) {
        const id = crypto.randomUUID()
        const path = buildAgentAttachmentPath(id, file.name)
        const reference = `@${path}`
        const inserted = insertAttachmentReference(text, reference, nextSelection)
        text = inserted.text
        nextSelection = { start: inserted.caret, end: inserted.caret }
        pendingFiles.push({ id, agentId, file, reference, path, status: 'uploading', progress: 0 })
      }
      setTextRef.current(text, nextSelection?.start, { focus: true })
      setFiles((current) => [...current, ...pendingFiles])
      for (const pending of pendingFiles) void performUpload(pending)
    },
    [agentId, getTextRef, performUpload, setTextRef]
  )

  const addFile = useCallback((file: File, selection?: TextSelection) => addFiles([file], selection), [addFiles])

  const removeFile = useCallback(
    async (id: string) => {
      const item = filesRef.current.find((candidate) => candidate.id === id)
      if (!item) return
      removed.current.add(id)
      controllers.current.get(id)?.abort()
      setFiles((current) => current.filter((candidate) => candidate.id !== id))
      let text = removeAttachmentReferences(getTextRef.current(), item.reference)
      if (item.canonicalReference) text = removeAttachmentReferences(text, item.canonicalReference)
      setTextRef.current(text, undefined, { focus: true })
      await deleteFile(item.agentId, id).catch(() => {})
      if (!controllers.current.has(id)) removed.current.delete(id)
    },
    [deleteFile, getTextRef, setTextRef]
  )

  const retryFile = useCallback(
    (id: string) => {
      const item = filesRef.current.find((candidate) => candidate.id === id)
      if (!item) return
      // Explicit user action, same as add/remove: return the caret (and
      // focus) to the composer before the upload restarts.
      setTextRef.current(getTextRef.current(), undefined, { focus: true })
      void performUpload(item)
    },
    [getTextRef, performUpload, setTextRef]
  )

  const settleOwnershipTransfer = useCallback(
    (success: boolean) => {
      ownershipTransferRef.current = false
      const deferred = [...deferredCleanup.current.values()]
      deferredCleanup.current.clear()
      if (!success) {
        for (const file of deferred) void deleteFile(file.agentId, file.id).catch(() => {})
      }
    },
    [deleteFile, ownershipTransferRef]
  )

  return {
    files,
    addFile,
    addFiles,
    removeFile,
    retryFile,
    beginOwnershipTransfer: () => {
      ownershipTransferRef.current = true
    },
    settleOwnershipTransfer,
    clearFiles: () => setFiles([]),
    blocked: files.some(({ status }) => status !== 'done'),
  }
}
