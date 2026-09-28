import clsx from 'clsx'
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { queries } from '../queryOptions'
import { useFullscreen } from '../hooks/useFullscreen'
import { Modal } from './Modal'
import { MarkdownContent } from './MarkdownContent'
import { SquadWorkspaceImageViewer } from './SquadWorkspaceImageViewer'
import { DocumentSkeleton } from './loading/Skeleton'

interface WorkStreamFileCardProps {
  filePath: string
  squadId: string
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

function getLanguageFromExt(ext: string | undefined): string {
  if (!ext) return 'text'
  const map: Record<string, string> = {
    ts: 'typescript',
    tsx: 'tsx',
    js: 'javascript',
    jsx: 'jsx',
    json: 'json',
    yml: 'yaml',
    yaml: 'yaml',
    py: 'python',
    rb: 'ruby',
    go: 'go',
    rs: 'rust',
    sql: 'sql',
    sh: 'bash',
    bash: 'bash',
    html: 'html',
    css: 'css',
    csv: 'csv',
  }
  return map[ext] || 'text'
}

function isMarkdown(name: string): boolean {
  const ext = name.split('.').pop()?.toLowerCase()
  return ext === 'md' || ext === 'markdown'
}

function isImageFile(name: string): boolean {
  const ext = name.split('.').pop()?.toLowerCase()
  return ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'bmp'].includes(ext ?? '')
}

function formatAsCodeBlock(content: string, language: string): string {
  return '```' + language + '\n' + content + '\n```'
}

export function WorkStreamFileCard({ filePath, squadId }: WorkStreamFileCardProps) {
  const { isFullscreen, toggleFullscreen, exitFullscreen } = useFullscreen()
  const [hasOpened, setHasOpened] = useState(false)

  const fileName = getFileName(filePath)
  const iconType = getFileIcon(fileName)
  const contentType = getContentType(fileName)

  // Only fetch when user has opened the modal
  const queryOpts = queries.squadWorkspace.file(squadId, filePath)
  const { data, isLoading, error } = useQuery({
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
        className="ficus-button flex items-center gap-3 px-3 py-3 rounded-xl border-0 bg-surface-secondary hover:bg-surface-hover transition-colors text-left w-full group"
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
          <p className="text-xs font-medium text-primary truncate group-hover:text-status-progress-600 dark:group-hover:text-status-progress-400 transition-colors">
            {fileName}
          </p>
          <p className="text-[10px] text-placeholder truncate">{filePath}</p>
        </div>
      </button>

      <Modal
        isOpen={isFullscreen}
        onClose={exitFullscreen}
        title={fileName}
        overlayClassName="!border-0"
        headerExtra={<span className="text-xs text-muted bg-surface-secondary px-2 py-0.5 rounded">{contentType}</span>}
        maxWidth="readable"
      >
        {isLoading && <DocumentSkeleton label="Loading work stream file" lines={10} className="min-h-64" />}
        {error && (
          <div className="flex items-center justify-center py-12 text-status-danger-500">
            <span>Failed to load file</span>
          </div>
        )}
        {data && !data.error && isImageFile(fileName) && (
          <div className="grow overflow-auto flex items-center justify-center p-4 bg-[rgb(var(--syntax-image-bg))] min-h-[200px]">
            <SquadWorkspaceImageViewer squadId={squadId} filePath={filePath} />
          </div>
        )}
        {data && !data.error && !data.binary && !isImageFile(fileName) && (
          <div className="grow overflow-auto">
            {isMarkdown(fileName) ? (
              <MarkdownContent>{data.content}</MarkdownContent>
            ) : (
              <MarkdownContent>
                {formatAsCodeBlock(data.content, getLanguageFromExt(fileName.split('.').pop()?.toLowerCase()))}
              </MarkdownContent>
            )}
          </div>
        )}
        {data?.error && (
          <div className="flex items-center justify-center py-12 text-muted">
            <span>{data.error}</span>
          </div>
        )}
        {data?.binary && !isImageFile(fileName) && (
          <div className="flex items-center justify-center py-12 text-muted">
            <span>Binary file cannot be displayed</span>
          </div>
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
