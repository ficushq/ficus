/**
 * FileUpload Component
 *
 * Drag-and-drop file/folder upload with progress indicator.
 */

import { DROP_ZONE_ATTRIBUTE } from '../../lib/dropZone'
import { useState, useCallback, useRef, useEffect } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { uploadToSquadWorkspace } from '../../api/workspace'
import { useStableRef } from '../../hooks/useStableRef'
import { FileIcon } from '../icons'
import { FolderIcon } from '../icons/FolderIcon'
import { usePermissions } from '../../hooks/usePermissions'

interface FileUploadProps {
  squadId: string
  targetDir?: string
  onUploadStart?: (paths: string[]) => void
  onUploadComplete?: () => void
}

interface FileWithPath {
  file: File
  relativePath: string
}

export function FileUpload({ squadId, targetDir = '', onUploadStart, onUploadComplete }: FileUploadProps) {
  const [isDragging, setIsDragging] = useState(false)
  const [showOverwriteDialog, setShowOverwriteDialog] = useState(false)
  const [pendingFiles, setPendingFiles] = useState<FileWithPath[]>([])
  const [skippedFiles, setSkippedFiles] = useState<string[]>([])
  const [uploadProgress, setUploadProgress] = useState(0)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const folderInputRef = useRef<HTMLInputElement>(null)
  const abortControllerRef = useRef<AbortController | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const dragCounterRef = useRef(0)
  const queryClient = useQueryClient()
  const { can, isLoading: permissionsLoading } = usePermissions(squadId)
  const canWriteWorkspace = !permissionsLoading && can('workspace:write')

  // Stable refs for callbacks
  const onUploadStartRef = useStableRef(onUploadStart)
  const onUploadCompleteRef = useStableRef(onUploadComplete)

  // Track drag events on the parent container to detect file dragging
  useEffect(() => {
    const handleDragEnter = (e: DragEvent) => {
      e.preventDefault()
      dragCounterRef.current++
      // Check if dragging files (not text or other content)
      if (canWriteWorkspace && e.dataTransfer?.types.includes('Files')) {
        setIsDragging(true)
      }
    }

    const handleDragLeave = (e: DragEvent) => {
      e.preventDefault()
      dragCounterRef.current--
      if (dragCounterRef.current === 0) {
        setIsDragging(false)
      }
    }

    const handleDragOver = (e: DragEvent) => {
      e.preventDefault()
      // Keep showing the overlay while dragging over
      if (canWriteWorkspace && e.dataTransfer?.types.includes('Files')) {
        setIsDragging(true)
      }
    }

    // Find the closest relative parent (the file tree container)
    const container = containerRef.current?.closest('.relative') as HTMLElement | null
    if (container) {
      // The global screenshot drop target leaves dropped files here to this upload.
      container.setAttribute(DROP_ZONE_ATTRIBUTE, '')
      container.addEventListener('dragenter', handleDragEnter)
      container.addEventListener('dragleave', handleDragLeave)
      container.addEventListener('dragover', handleDragOver)
      // Note: drop is handled by the overlay, not here

      return () => {
        container.removeAttribute(DROP_ZONE_ATTRIBUTE)
        container.removeEventListener('dragenter', handleDragEnter)
        container.removeEventListener('dragleave', handleDragLeave)
        container.removeEventListener('dragover', handleDragOver)
      }
    }
  }, [canWriteWorkspace])

  const uploadMutation = useMutation({
    mutationFn: async ({ files, overwrite }: { files: FileWithPath[]; overwrite: boolean }) => {
      // Create new AbortController for this upload
      abortControllerRef.current = new AbortController()
      const signal = abortControllerRef.current.signal
      setUploadProgress(0)
      setUploadError(null)

      const onProgress = (progress: number) => setUploadProgress(progress)

      return uploadToSquadWorkspace(squadId, files, { targetDir, overwrite, signal, onProgress })
    },
    onSuccess: (data) => {
      abortControllerRef.current = null
      // A 200 response can still carry per-file failures — the route uploads
      // each file independently and reports {status: 'error', error} rows.
      // Silently ignoring them made a failed upload look like it vanished at
      // 100%.
      const failed = data.results.filter((r) => r.status === 'error')
      if (failed.length > 0) {
        setUploadError(failed.map((r) => `${r.path}: ${r.error ?? 'upload failed'}`).join('\n'))
      }
      // Check if any files were skipped
      const skipped = data.results.filter((r) => r.status === 'skipped').map((r) => r.path)
      if (skipped.length > 0) {
        setSkippedFiles(skipped)
        setPendingFiles(pendingFiles.filter((f) => skipped.includes(f.relativePath)))
        setShowOverwriteDialog(true)
      } else {
        // Refresh the file tree (some files may have succeeded even when
        // others failed)
        queryClient.invalidateQueries({ queryKey: ['squadWorkspace', squadId] })
        onUploadCompleteRef.current?.()
      }
    },
    onError: (error) => {
      abortControllerRef.current = null
      // Don't show error for cancelled uploads
      if (error instanceof Error && error.message === 'Upload cancelled') {
        onUploadCompleteRef.current?.()
        return
      }
      // Show error message
      const message = error instanceof Error ? error.message : 'Upload failed'
      setUploadError(message)
      // Clear pending uploads on error
      onUploadCompleteRef.current?.()
    },
  })

  const handleCancelUpload = useCallback(() => {
    abortControllerRef.current?.abort()
    abortControllerRef.current = null
  }, [])

  const processFiles = useCallback(async (items: DataTransferItemList | FileList) => {
    const files: FileWithPath[] = []

    if (items instanceof FileList) {
      // From file input
      for (const file of Array.from(items)) {
        // webkitRelativePath is available for folder uploads
        const relativePath = (file as any).webkitRelativePath || file.name
        files.push({ file, relativePath })
      }
    } else {
      // From drag-and-drop
      const entries: FileSystemEntry[] = []
      for (const item of Array.from(items)) {
        const entry = item.webkitGetAsEntry?.()
        if (entry) entries.push(entry)
      }

      // Recursively read entries
      const readEntry = async (entry: FileSystemEntry, basePath = ''): Promise<void> => {
        if (entry.isFile) {
          const fileEntry = entry as FileSystemFileEntry
          const file = await new Promise<File>((resolve, reject) => {
            fileEntry.file(resolve, reject)
          })
          const relativePath = basePath ? `${basePath}/${entry.name}` : entry.name
          files.push({ file, relativePath })
        } else if (entry.isDirectory) {
          const dirEntry = entry as FileSystemDirectoryEntry
          const reader = dirEntry.createReader()
          const entries = await new Promise<FileSystemEntry[]>((resolve, reject) => {
            reader.readEntries(resolve, reject)
          })
          const newBasePath = basePath ? `${basePath}/${entry.name}` : entry.name
          for (const childEntry of entries) {
            await readEntry(childEntry, newBasePath)
          }
        }
      }

      for (const entry of entries) {
        await readEntry(entry)
      }
    }

    return files
  }, [])

  const handleDragOver = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
      if (canWriteWorkspace) setIsDragging(true)
    },
    [canWriteWorkspace]
  )

  const handleDrop = useCallback(
    async (e: React.DragEvent) => {
      if (!canWriteWorkspace) return
      e.preventDefault()
      e.stopPropagation()
      setIsDragging(false)

      const files = await processFiles(e.dataTransfer.items)
      if (files.length > 0) {
        setPendingFiles(files)
        onUploadStartRef.current?.(files.map((f) => (targetDir ? `${targetDir}/${f.relativePath}` : f.relativePath)))
        uploadMutation.mutate({ files, overwrite: false })
      }
    },
    [canWriteWorkspace, processFiles, uploadMutation, targetDir]
  )

  const handleFileSelect = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      if (!canWriteWorkspace) return
      const fileList = e.target.files
      if (!fileList || fileList.length === 0) return

      const files = await processFiles(fileList)
      if (files.length > 0) {
        setPendingFiles(files)
        onUploadStartRef.current?.(files.map((f) => (targetDir ? `${targetDir}/${f.relativePath}` : f.relativePath)))
        uploadMutation.mutate({ files, overwrite: false })
      }

      // Reset input
      e.target.value = ''
    },
    [canWriteWorkspace, processFiles, uploadMutation, targetDir]
  )

  const handleOverwriteConfirm = () => {
    setShowOverwriteDialog(false)
    const filesToOverwrite = pendingFiles.filter((f) => skippedFiles.includes(f.relativePath))
    uploadMutation.mutate({ files: filesToOverwrite, overwrite: true })
    setPendingFiles([])
    setSkippedFiles([])
  }

  const handleOverwriteCancel = () => {
    setShowOverwriteDialog(false)
    setPendingFiles([])
    setSkippedFiles([])
    // Refresh to show what was uploaded
    queryClient.invalidateQueries({ queryKey: ['squadWorkspace', squadId] })
    onUploadCompleteRef.current?.()
  }

  return (
    <div ref={containerRef} className="contents">
      {/* Drop zone overlay - visual feedback and drop target when dragging */}
      {isDragging && (
        <div
          className="absolute inset-0 flex items-center justify-center z-10 border-2 border-dashed border-accent rounded"
          onDragOver={handleDragOver}
          onDragLeave={(e) => {
            // Only handle if leaving to outside the container
            const rect = e.currentTarget.getBoundingClientRect()
            const { clientX, clientY } = e
            if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) {
              setIsDragging(false)
            }
          }}
          onDrop={handleDrop}
        >
          <div className="absolute inset-0 bg-chrome-scrim/70 pointer-events-none" />
          <div className="text-center pointer-events-none z-10">
            <p className="text-lg font-medium text-accent-light">Drop files here</p>
            <p className="text-sm text-muted">Files and folders will be uploaded</p>
          </div>
        </div>
      )}

      {/* Upload buttons */}
      <div className="border-t border-panel-border">
        <div className="flex flex-wrap items-center gap-1 px-2 py-2">
          <input ref={fileInputRef} type="file" multiple className="hidden" onChange={handleFileSelect} />
          <input
            ref={folderInputRef}
            type="file"
            multiple
            {...({ webkitdirectory: '', directory: '' } as any)}
            className="hidden"
            onChange={handleFileSelect}
          />

          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={!canWriteWorkspace || uploadMutation.isPending}
            className="ficus-button ficus-button-ghost inline-flex items-center gap-1.5 text-xs px-2 py-2 rounded-lg disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <FileIcon className="h-3.5 w-3.5" /> Upload files
          </button>
          <button
            onClick={() => folderInputRef.current?.click()}
            disabled={!canWriteWorkspace || uploadMutation.isPending}
            className="ficus-button ficus-button-ghost inline-flex items-center gap-1.5 text-xs px-2 py-2 rounded-lg disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <FolderIcon className="h-3.5 w-3.5" /> Upload folder
          </button>

          {uploadMutation.isPending && (
            <button
              onClick={handleCancelUpload}
              className="ficus-button ficus-button-danger text-xs px-2 py-1 rounded cursor-pointer"
              title="Cancel upload"
            >
              Cancel
            </button>
          )}
        </div>

        {uploadMutation.isPending && (
          <div className="flex items-center gap-2 px-3 pb-2">
            <div className="flex-1 h-1.5 bg-surface rounded-full overflow-hidden">
              <div className="h-full bg-accent transition-all duration-150" style={{ width: `${uploadProgress}%` }} />
            </div>
            <span className="text-xs text-muted tabular-nums w-8">{uploadProgress}%</span>
          </div>
        )}

        {uploadError && (
          <div className="flex items-center gap-2 px-3 pb-2">
            <span className="text-xs text-status-danger-500 flex-1 whitespace-pre-line">{uploadError}</span>
            <button
              onClick={() => setUploadError(null)}
              className="ficus-button ficus-button-ghost text-xs"
              title="Dismiss"
            >
              ✕
            </button>
          </div>
        )}
      </div>

      {/* Overwrite confirmation dialog */}
      {showOverwriteDialog && (
        <div className="fixed inset-0 bg-chrome-scrim/50 flex items-center justify-center z-50">
          <div className="ficus-overlay bg-surface rounded-lg shadow-xl p-6 max-w-md w-full mx-4">
            <h3 className="text-lg font-semibold text-primary mb-2">Files already exist</h3>
            <p className="text-sm text-muted mb-4">{skippedFiles.length} file(s) already exist at the destination:</p>
            <ul className="text-sm text-secondary mb-4 max-h-32 overflow-y-auto">
              {skippedFiles.slice(0, 5).map((path) => (
                <li key={path} className="truncate">
                  • {path}
                </li>
              ))}
              {skippedFiles.length > 5 && <li className="text-muted">...and {skippedFiles.length - 5} more</li>}
            </ul>
            <div className="flex gap-3 justify-end">
              <button
                onClick={handleOverwriteCancel}
                className="ficus-button ficus-button-secondary px-4 py-2 text-sm rounded"
              >
                Skip
              </button>
              <button
                onClick={handleOverwriteConfirm}
                className="ficus-button ficus-button-primary px-4 py-2 text-sm rounded"
              >
                Overwrite
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
