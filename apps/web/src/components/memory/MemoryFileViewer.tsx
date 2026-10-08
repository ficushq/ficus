import { useQuery } from '@tanstack/react-query'
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter'
import { syntaxTheme } from '../../theme/syntax'
import type { FileContent } from '../../api/workspace'
import { getSquadMemoryDownloadUrl } from '../../api/workspace'
import { authFetch } from '../../api/client'
import { queries } from '../../queryOptions'
import { DownloadIcon } from '../icons'
import { DocumentSkeleton, LoadingContent, SkeletonText } from '../loading/Skeleton'

export interface MemoryFileViewerProps {
  squadId: string
  filePath: string
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function getLanguage(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() || ''
  if (ext === 'md' || ext === 'mdx') return 'markdown'
  if (ext === 'json') return 'json'
  if (ext === 'yaml' || ext === 'yml') return 'yaml'
  return 'text'
}

function MemoryFileHeader({
  path,
  size,
  language,
  squadId,
}: {
  path: string
  size?: number
  language: string
  squadId: string
}) {
  const handleDownload = () => {
    const downloadUrl = getSquadMemoryDownloadUrl(squadId, path)
    const fileName = path.split('/').pop() || 'download'

    authFetch(downloadUrl)
      .then((response) => response.blob())
      .then((blob) => {
        const url = window.URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = fileName
        document.body.appendChild(a)
        a.click()
        window.URL.revokeObjectURL(url)
        document.body.removeChild(a)
      })
      .catch((err) => console.error('Download failed:', err))
  }

  return (
    <div className="flex min-h-10 shrink-0 items-center justify-between gap-3 px-3 py-2">
      <span className="text-sm font-mono text-secondary truncate" title={path}>
        {path.replace(/^\/memory\//, '')}
      </span>
      <div className="flex items-center gap-3 text-xs text-muted shrink-0">
        {language !== 'text' && <span className="hidden sm:inline">{language}</span>}
        <span className="hidden sm:inline">
          <LoadingContent loading={size === undefined} fallback={<SkeletonText className="w-12" />}>
            {size !== undefined && formatSize(size)}
          </LoadingContent>
        </span>
        <button
          onClick={handleDownload}
          disabled={size === undefined}
          className="ficus-button ficus-button-ghost p-1 rounded transition-colors"
          title="Download memory file"
        >
          <DownloadIcon className="w-4 h-4" />
        </button>
      </div>
    </div>
  )
}

export function MemoryFileViewer({ squadId, filePath }: MemoryFileViewerProps) {
  const queryOpts = queries.squadMemory.file(squadId, filePath)
  const {
    data: file,
    isLoading,
    isError,
    error,
  } = useQuery<FileContent>({
    queryKey: queryOpts.queryKey as any,
    queryFn: queryOpts.queryFn as any,
    staleTime: 10000,
  })

  const language = getLanguage(filePath)
  const lineCount = file?.content.split('\n').length ?? 1
  const lineNumberDigits = String(lineCount).length

  return (
    <div className="h-full flex flex-col">
      <MemoryFileHeader path={filePath} size={file?.size} language={language} squadId={squadId} />
      <LoadingContent
        loading={isLoading}
        fallback={<DocumentSkeleton label="Loading memory file" className="flex-1" />}
      >
        {isError ? (
          <p className="p-4 text-sm text-muted">
            Failed to load memory file: {error instanceof Error ? error.message : 'Unknown error'}
          </p>
        ) : !file ? (
          <p className="p-4 text-sm text-muted">Memory file not found</p>
        ) : (
          <div className="flex-1 overflow-auto min-w-0 [&_code_span:not(.linenumber)]:!inline">
            <SyntaxHighlighter
              language={language}
              style={syntaxTheme}
              codeTagProps={{ style: { background: 'transparent' } }}
              showLineNumbers
              customStyle={{
                margin: 0,
                borderRadius: 0,
                minHeight: '100%',
                fontSize: '13px',
                lineHeight: '1.65',
                background: 'rgb(var(--syntax-memory-bg))',
                padding: '1rem',
              }}
              lineNumberStyle={{
                minWidth: `${lineNumberDigits}ch`,
                width: `${lineNumberDigits}ch`,
                paddingRight: '1.5em',
                userSelect: 'none',
                opacity: 0.5,
                textAlign: 'right',
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
                fontVariantNumeric: 'tabular-nums',
                boxSizing: 'content-box',
              }}
            >
              {file.content}
            </SyntaxHighlighter>
          </div>
        )}
      </LoadingContent>
    </div>
  )
}
