import clsx from 'clsx'
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { isSandboxProvisioningFailure } from '@ficus/client-core'
import { SandboxStartingNotice } from './workspace/SandboxStartingNotice'
import { queries } from '../queryOptions'
import { useFullscreen } from '../hooks/useFullscreen'
import { Modal } from './Modal'
import { FilePreview } from './FilePreview'
import { SquadWorkspaceImageViewer } from './SquadWorkspaceImageViewer'
import { DocumentSkeleton } from './loading/Skeleton'
import type { WorkStream } from '@ficus/shared'
import {
  ATTACHMENT_SOURCE_LABELS,
  handoffDocument,
  storedDocument,
  storedInputPresentation,
  workspaceFileLoadError,
  type ReviewDocument,
} from '../lib/workflowAttachments'
import { AttachmentView } from './WorkflowReviewAttachments'

interface WorkStreamFileCardProps {
  filePath: string
  squadId: string
  /** The muted line under the name; the full path by default. The path stays in the viewer either way. */
  detail?: string
}

function getFileIcon(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase()

  if (ext === 'md') return 'doc'
  if (ext === 'json') return 'json'
  if (ext === 'csv') return 'csv'
  if (ext === 'yml' || ext === 'yaml') return 'yml'
  if (ext === 'html') return 'html'
  if (ext === 'ts' || ext === 'tsx' || ext === 'js' || ext === 'jsx') return 'code'
  if (ext === 'py' || ext === 'rb' || ext === 'go' || ext === 'rs') return 'code'
  if (ext === 'sql') return 'sql'
  if (ext === 'sh' || ext === 'bash') return 'sh'
  if (['png', 'jpg', 'jpeg', 'gif', 'svg'].includes(ext ?? '')) return 'img'
  return 'file'
}

const iconColors: Record<string, string> = {
  doc: 'bg-status-progress-100 dark:bg-status-progress-900/30 text-status-progress-600 dark:text-status-progress-400',
  json: 'bg-status-review-100 dark:bg-status-review-900/30 text-status-review-700 dark:text-status-review-400',
  csv: 'bg-status-success-100 dark:bg-status-success-900/30 text-status-success-700 dark:text-status-success-400',
  yml: 'bg-status-human-wait-100 dark:bg-status-human-wait-900/30 text-status-human-wait-600 dark:text-status-human-wait-400',
  html: 'bg-status-external-wait-100 dark:bg-status-external-wait-900/30 text-status-external-wait-600 dark:text-status-external-wait-400',
  code: 'bg-decoration-8-100 dark:bg-decoration-8-900/30 text-decoration-8-600 dark:text-decoration-8-400',
  sql: 'bg-status-queue-100 dark:bg-status-queue-900/30 text-status-queue-700 dark:text-status-queue-400',
  sh: 'bg-status-neutral-200 dark:bg-status-neutral-700 text-status-neutral-600 dark:text-status-neutral-300',
  img: 'bg-decoration-9-100 dark:bg-decoration-9-900/30 text-decoration-9-600 dark:text-decoration-9-400',
  file: 'bg-surface-secondary text-muted',
}

const iconLabels: Record<string, string> = {
  doc: 'MD',
  json: '{ }',
  csv: 'CSV',
  yml: 'YML',
  html: '</>',
  code: '< >',
  sql: 'SQL',
  sh: '>_',
  img: 'IMG',
  file: 'TXT',
}

function getContentType(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase()

  if (ext === 'md') return 'text/markdown'
  if (ext === 'json') return 'application/json'
  if (ext === 'csv') return 'text/csv'
  if (ext === 'yml' || ext === 'yaml') return 'application/yaml'
  if (ext === 'html') return 'text/html'
  if (ext === 'ts') return 'text/typescript'
  if (ext === 'tsx') return 'text/typescript'
  if (ext === 'js') return 'text/javascript'
  if (ext === 'jsx') return 'text/javascript'
  if (ext === 'py') return 'text/x-python'
  if (ext === 'sql') return 'text/sql'
  if (ext === 'sh' || ext === 'bash') return 'text/x-sh'
  return 'text/plain'
}

function getFileName(filePath: string): string {
  return filePath.split('/').pop() || filePath
}

function isImageFile(name: string): boolean {
  const ext = name.split('.').pop()?.toLowerCase()
  return ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'bmp'].includes(ext ?? '')
}

/** Why the file could not be loaded, with Try again when another attempt could help. */
function WorkspaceFileError({
  fileName,
  error,
  retrying,
  onRetry,
}: {
  fileName: string
  error: unknown
  retrying: boolean
  onRetry: () => void
}) {
  const { message, retry } = workspaceFileLoadError(error)
  return (
    <FilePreview fileName={fileName} kind="unavailable">
      <span role="alert">{message}</span>
      {retry && (
        <button
          type="button"
          className="ficus-button ficus-button-secondary px-2.5 py-1 text-xs disabled:opacity-50"
          disabled={retrying}
          onClick={onRetry}
        >
          {retrying ? 'Trying again…' : 'Try again'}
        </button>
      )}
    </FilePreview>
  )
}

export function WorkStreamFileCard({ filePath, squadId, detail }: WorkStreamFileCardProps) {
  const { isFullscreen, toggleFullscreen, exitFullscreen } = useFullscreen()
  const [hasOpened, setHasOpened] = useState(false)

  const fileName = getFileName(filePath)
  const iconType = getFileIcon(fileName)
  const contentType = getContentType(fileName)

  // Only fetch when user has opened the modal
  const queryOpts = queries.squadWorkspace.file(squadId, filePath)
  const { data, isLoading, error, refetch, isFetching, failureReason } = useQuery({
    ...queryOpts,
    enabled: hasOpened,
  })

  const handleClick = () => {
    setHasOpened(true)
    toggleFullscreen()
  }

  return (
    <>
      <button
        onClick={handleClick}
        title={filePath}
        className="ficus-button ficus-button-secondary flex items-center gap-3 px-3 py-3 rounded-xl transition-colors text-left w-full group"
      >
        <div
          className={clsx(
            'shrink-0 w-7 h-7 rounded flex items-center justify-center text-[10px] font-bold',
            iconColors[iconType]
          )}
        >
          {iconLabels[iconType]}
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium text-primary truncate group-hover:text-link-hover transition-colors">
            {fileName}
          </p>
          <p className="text-[10px] text-placeholder truncate">{detail ?? filePath}</p>
        </div>
      </button>

      <Modal
        isOpen={isFullscreen}
        onClose={exitFullscreen}
        title={fileName}
        overlayClassName="border-0!"
        headerExtra={<span className="text-xs text-muted bg-surface-secondary px-2 py-0.5 rounded">{contentType}</span>}
        maxWidth="readable"
      >
        {detail && <p className="mb-3 break-all font-mono text-xs text-muted">{filePath}</p>}
        {isLoading &&
          (isSandboxProvisioningFailure(failureReason) ? (
            <SandboxStartingNotice
              subject="This file"
              className="flex min-h-64 flex-col items-center justify-center gap-2 p-4 text-center"
            />
          ) : (
            <DocumentSkeleton label="Loading work stream file" lines={10} className="min-h-64" />
          ))}
        {error && (
          <WorkspaceFileError fileName={fileName} error={error} retrying={isFetching} onRetry={() => void refetch()} />
        )}
        {data && !data.error && isImageFile(fileName) && (
          <FilePreview
            fileName={fileName}
            scroll
            kind="image"
            image={<SquadWorkspaceImageViewer squadId={squadId} filePath={filePath} />}
          />
        )}
        {data && !data.error && !data.binary && !isImageFile(fileName) && (
          <FilePreview fileName={fileName} scroll kind="text" content={data.content} />
        )}
        {data?.error && (
          <FilePreview fileName={fileName} kind="unavailable">
            <span>{data.error}</span>
          </FilePreview>
        )}
        {data?.binary && !isImageFile(fileName) && (
          <FilePreview fileName={fileName} kind="unavailable">
            <span>Binary file cannot be displayed</span>
          </FilePreview>
        )}
      </Modal>
    </>
  )
}

/**
 * Renders a list of work stream file attachments
 */
export function WorkStreamFileList({ files, squadId }: { files: string[]; squadId: string }) {
  if (!files || files.length === 0) return null

  return (
    <div className="space-y-1.5 mt-2">
      {files.map((filePath) => (
        <WorkStreamFileCard key={filePath} filePath={filePath} squadId={squadId} />
      ))}
    </div>
  )
}

/**
 * Every file a work stream carries, in one list: its stored inputs (chat images, chat files and inbox
 * attachments Ficus holds, shared by ID, titled by their label when they have one), its workspace files (live paths into the squad workspace) and the files its steps
 * handed off. They stay distinct underneath, and each row says which it is; each opens in the viewer
 * for its kind. Renders nothing while there are none.
 */
export function WorkStreamAttachments({ stream }: { stream: WorkStream }) {
  const { data: run } = useQuery(queries.workflows.run(stream.id))
  const { isFullscreen, toggleFullscreen, exitFullscreen } = useFullscreen()
  const [open, setOpen] = useState<{ document: ReviewDocument; name: string } | null>(null)
  const files = [...new Set((stream.files ?? []).map((path) => path.trim()).filter(Boolean))]
  const documents: Array<{ document: ReviewDocument; name: string; source: string; title?: string }> = [
    ...(stream.assetAttachments ?? []).map((asset) => {
      const { title, detail } = storedInputPresentation(asset)
      return { document: storedDocument(asset), name: title, source: detail }
    }),
    ...Object.values(run?.attachments ?? {})
      .flat()
      .map((file) => ({
        document: handoffDocument(file),
        name: file.filename,
        source: ATTACHMENT_SOURCE_LABELS.handoff,
        title: file.path,
      })),
    ...Object.values(run?.assetAttachments ?? {})
      .flat()
      .map((asset) => ({
        document: storedDocument(asset),
        name: storedInputPresentation(asset).title,
        source: ATTACHMENT_SOURCE_LABELS.handoff,
      })),
  ]
  if (documents.length === 0 && files.length === 0) return null
  return (
    <section aria-label="Attachments">
      <h3 className="text-xs font-medium text-secondary">Attachments</h3>
      <div className="space-y-1.5 mt-2">
        {documents.map(({ document, name, source, title }) => (
          <button
            key={`${document.stored ? 'stored' : 'snapshot'}:${document.id}`}
            type="button"
            title={title}
            onClick={() => {
              setOpen({ document, name })
              toggleFullscreen()
            }}
            className="ficus-button ficus-button-secondary flex items-center gap-3 px-3 py-3 rounded-xl transition-colors text-left w-full group"
          >
            <div
              className={clsx(
                'shrink-0 w-7 h-7 rounded flex items-center justify-center text-[10px] font-bold',
                iconColors[getFileIcon(document.filename)]
              )}
            >
              {iconLabels[getFileIcon(document.filename)]}
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-xs font-medium text-primary truncate group-hover:text-link-hover transition-colors">
                {name}
              </p>
              <p className="text-[10px] text-placeholder truncate">{source}</p>
            </div>
          </button>
        ))}
        {files.map((filePath) => (
          <WorkStreamFileCard
            key={filePath}
            filePath={filePath}
            squadId={stream.squadId}
            detail={ATTACHMENT_SOURCE_LABELS.workspace}
          />
        ))}
      </div>
      <Modal
        isOpen={isFullscreen && open !== null}
        onClose={() => {
          exitFullscreen()
          setOpen(null)
        }}
        title={open?.name ?? ''}
        overlayClassName="border-0!"
        maxWidth="readable"
      >
        {open && <AttachmentView key={open.document.id} workStreamId={stream.id} attachment={open.document} />}
      </Modal>
    </section>
  )
}
