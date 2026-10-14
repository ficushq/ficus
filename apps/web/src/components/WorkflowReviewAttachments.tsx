import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { workflowAttachmentContentType, type WorkflowAttemptAttachment } from '@ficus/shared'
import { actionErrorMessage } from '../lib/actionError'
import { attachmentPreviewMode } from '../lib/workflowAttachments'
import { queries } from '../queryOptions'
import { FilePreview } from './FilePreview'
import { PdfPreview } from './PdfPreview'
import { DocumentSkeleton } from './loading/Skeleton'

/** The handoff tab's id; attachment tabs use their attachment id. */
export const HANDOFF_TAB = 'handoff'

/** How long a programmatic download's blob URL stays alive. */
const DOWNLOAD_URL_LIFETIME_MS = 60_000

/**
 * The review document's tab row: the handoff first, then each handed-off file. It scrolls sideways when
 * the names do not fit, and arrow keys, Home and End move between tabs (selection follows focus).
 */
export function ReviewTabs({
  idPrefix,
  attachments,
  selected,
  onSelect,
}: {
  idPrefix: string
  attachments: WorkflowAttemptAttachment[]
  selected: string
  onSelect: (id: string) => void
}) {
  const tabs = [
    { id: HANDOFF_TAB, label: 'Handoff', title: undefined as string | undefined },
    ...attachments.map((attachment) => ({ id: attachment.id, label: attachment.filename, title: attachment.path })),
  ]
  const list = useRef<HTMLDivElement>(null)
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = tabs.findIndex((tab) => tab.id === selected)
    const next =
      event.key === 'ArrowRight'
        ? (index + 1) % tabs.length
        : event.key === 'ArrowLeft'
          ? (index - 1 + tabs.length) % tabs.length
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? tabs.length - 1
              : -1
    if (next < 0) return
    event.preventDefault()
    onSelect(tabs[next]!.id)
    const button = list.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]
    button?.focus()
    button?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
  }
  return (
    <div className="sticky top-0 z-10 border-b border-panel-border bg-overlay">
      <div
        ref={list}
        role="tablist"
        aria-label="Review documents"
        onKeyDown={onKeyDown}
        className="mx-auto flex w-full max-w-[72ch] gap-0.5 overflow-x-auto px-3 py-1.5 [scrollbar-width:none] sm:px-6 [&::-webkit-scrollbar]:hidden"
      >
        {tabs.map((tab) => (
          <button
            key={tab.id}
            id={`${idPrefix}-tab-${tab.id}`}
            type="button"
            role="tab"
            aria-selected={tab.id === selected}
            aria-controls={`${idPrefix}-panel`}
            tabIndex={tab.id === selected ? 0 : -1}
            title={tab.title}
            onClick={() => onSelect(tab.id)}
            className="ficus-button ficus-button-ghost ficus-nav-item max-w-[24ch] shrink-0 truncate whitespace-nowrap px-3 py-2 text-sm font-medium"
          >
            {tab.label}
          </button>
        ))}
      </div>
    </div>
  )
}

/** A blob URL for bytes, revoked when they change or the view unmounts. */
function useObjectUrl(bytes: Uint8Array | undefined, type: string): string | undefined {
  const [url, setUrl] = useState<string>()
  useEffect(() => {
    if (!bytes) return
    const next = URL.createObjectURL(new Blob([bytes as BlobPart], { type }))
    setUrl(next)
    return () => {
      URL.revokeObjectURL(next)
      setUrl(undefined)
    }
  }, [bytes, type])
  return url
}

function decodeText(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return null
  }
}

/** One handed-off file, loaded when its tab is first opened and rendered by the shared file viewer. */
export function AttachmentView({
  workStreamId,
  attachment,
}: {
  workStreamId: string
  attachment: WorkflowAttemptAttachment
}) {
  const mode = attachmentPreviewMode(attachment)
  const options = queries.workflows.attachment(workStreamId, attachment.id)
  const { data: bytes, error } = useQuery({ ...options, enabled: mode !== 'download' })
  const queryClient = useQueryClient()
  const [downloadError, setDownloadError] = useState<string>()
  const [pdfFailed, setPdfFailed] = useState(false)
  const imageUrl = useObjectUrl(
    mode === 'image' ? bytes : undefined,
    workflowAttachmentContentType(attachment.filename)
  )
  const download = async () => {
    setDownloadError(undefined)
    try {
      const data = await queryClient.fetchQuery(options)
      const url = URL.createObjectURL(new Blob([data as BlobPart], { type: 'application/octet-stream' }))
      const link = document.createElement('a')
      link.href = url
      link.download = attachment.filename
      link.click()
      // Revoking at once can cancel the download (Safari); a minute is ample for it to start.
      setTimeout(() => URL.revokeObjectURL(url), DOWNLOAD_URL_LIFETIME_MS)
    } catch (failure) {
      setDownloadError(actionErrorMessage(failure))
    }
  }
  const downloadButton = (
    <button type="button" onClick={download} className="ficus-button ficus-button-secondary px-3 py-1.5 text-sm">
      Download
    </button>
  )
  const text = mode === 'text' && bytes ? decodeText(bytes) : undefined
  let body: ReactNode
  if (error)
    body = (
      <p role="alert" className="py-12 text-center text-sm text-status-danger-600 dark:text-status-danger-400">
        This file could not be loaded. {actionErrorMessage(error)}
      </p>
    )
  else if (mode === 'download' || text === null || pdfFailed)
    body = (
      <FilePreview fileName={attachment.filename} kind="unavailable">
        <p className="text-sm">
          {pdfFailed
            ? 'This PDF cannot be previewed here. It may be damaged or password-protected.'
            : text === null
              ? 'This file is not plain text, so it cannot be previewed here.'
              : attachmentPreviewMode({ ...attachment, byteSize: 0 }) === 'text'
                ? 'This file is too large to preview here.'
                : 'This file type cannot be previewed here.'}
        </p>
        {downloadButton}
      </FilePreview>
    )
  else if (mode === 'image' && imageUrl)
    body = (
      <FilePreview
        fileName={attachment.filename}
        kind="image"
        image={<img src={imageUrl} alt={attachment.filename} className="max-w-full object-contain" />}
      />
    )
  else if (mode === 'pdf' && bytes)
    body = <PdfPreview bytes={bytes} fileName={attachment.filename} onError={() => setPdfFailed(true)} />
  else if (typeof text === 'string') body = <FilePreview fileName={attachment.filename} kind="text" content={text} />
  else body = <DocumentSkeleton label={`Loading ${attachment.filename}`} lines={10} className="min-h-64" />
  return (
    <section aria-label={attachment.filename} className="space-y-4">
      <div className="flex min-w-0 items-center gap-3 border-b border-panel-border pb-2">
        <p className="min-w-0 flex-1 truncate text-xs text-muted" title={attachment.path}>
          {attachment.path}
        </p>
        {mode !== 'download' && text !== null && !pdfFailed && (
          <button
            type="button"
            onClick={download}
            className="ficus-button ficus-button-link shrink-0 text-xs font-medium"
          >
            Download
          </button>
        )}
      </div>
      {body}
      {downloadError && (
        <p role="alert" className="text-xs text-status-danger-600 dark:text-status-danger-400">
          {downloadError}
        </p>
      )}
    </section>
  )
}
