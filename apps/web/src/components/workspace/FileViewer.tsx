/**
 * FileViewer Component
 *
 * Read-only file viewer with syntax highlighting and image support.
 */

import { useQuery } from '@tanstack/react-query'
import { queries } from '../../queryOptions'
import type { FileContent } from '../../api/workspace'
import { getSquadWorkspaceDownloadUrl } from '../../api/workspace'
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter'
import { syntaxTheme } from '../../theme/syntax'
import { authFetch } from '../../api/client'
import { DownloadIcon } from '../icons'
import { SquadWorkspaceImageViewer } from '../SquadWorkspaceImageViewer'
import { DocumentSkeleton, SkeletonBlock, SkeletonLine } from '../loading/Skeleton'

// Image file extensions
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.ico', '.bmp'])

export interface FileViewerProps {
  squadId: string
  filePath: string
}

// Map file extensions to Prism language names
const extensionToLanguage: Record<string, string> = {
  // JavaScript / TypeScript
  js: 'javascript',
  jsx: 'jsx',
  ts: 'typescript',
  tsx: 'tsx',
  mjs: 'javascript',
  cjs: 'javascript',

  // Web
  html: 'html',
  htm: 'html',
  css: 'css',
  scss: 'scss',
  sass: 'sass',
  less: 'less',

  // Data
  json: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  xml: 'xml',
  toml: 'toml',

  // Shell
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  fish: 'bash',

  // Python
  py: 'python',
  pyx: 'python',
  pyw: 'python',

  // Go
  go: 'go',

  // Rust
  rs: 'rust',

  // Ruby
  rb: 'ruby',
  erb: 'erb',

  // PHP
  php: 'php',

  // Java / Kotlin
  java: 'java',
  kt: 'kotlin',
  kts: 'kotlin',

  // C / C++
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  hpp: 'cpp',
  cc: 'cpp',
  cxx: 'cpp',

  // C#
  cs: 'csharp',

  // SQL
  sql: 'sql',

  // Markdown
  md: 'markdown',
  mdx: 'markdown',

  // Docker
  dockerfile: 'docker',

  // Config files
  env: 'bash',
  gitignore: 'gitignore',
  dockerignore: 'gitignore',

  // Other
  txt: 'text',
  log: 'text',
}

function isImageFile(filePath: string): boolean {
  const ext = '.' + (filePath.split('.').pop()?.toLowerCase() || '')
  return IMAGE_EXTENSIONS.has(ext)
}

function getLanguage(filePath: string): string {
  const fileName = filePath.split('/').pop() || ''
  const lowerFileName = fileName.toLowerCase()

  // Handle special file names
  if (lowerFileName === 'dockerfile') return 'docker'
  if (lowerFileName === 'makefile') return 'makefile'
  if (lowerFileName === '.gitignore' || lowerFileName === '.dockerignore') return 'gitignore'
  if (lowerFileName === '.env' || lowerFileName.startsWith('.env.')) return 'bash'

  // Get extension
  const ext = fileName.split('.').pop()?.toLowerCase() || ''
  return extensionToLanguage[ext] || 'text'
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function FileViewer({ squadId, filePath }: FileViewerProps) {
  const queryOpts = queries.squadWorkspace.file(squadId, filePath)
  const {
    data: file,
    isLoading,
    isError,
    error,
  } = useQuery<FileContent>({
    queryKey: queryOpts.queryKey as any,
    queryFn: queryOpts.queryFn as any,
    staleTime: 10000, // Cache for 10 seconds
  })

  if (isLoading) {
    return (
      <div className="flex h-full flex-col">
        <div className="flex items-center justify-between border-b border-th-border px-3 py-2">
          <span className="truncate font-mono text-sm text-secondary">{filePath}</span>
          <div className="flex shrink-0 items-center gap-3">
            <SkeletonLine className="w-10" />
            <SkeletonBlock className="h-6 w-6" />
          </div>
        </div>
        <DocumentSkeleton label="Loading file" className="flex-1" />
      </div>
    )
  }

  if (isError) {
    return (
      <div className="h-full flex items-center justify-center text-[rgb(var(--syntax-error-fg))]">
        Failed to load file: {error instanceof Error ? error.message : 'Unknown error'}
      </div>
    )
  }

  if (!file) {
    return <div className="h-full flex items-center justify-center text-muted">File not found</div>
  }

  // Handle errors from the API (e.g., file too large)
  if (file.error) {
    return (
      <div className="h-full flex flex-col">
        <FileHeader path={filePath} size={file.size} squadId={squadId} />
        <div className="flex-1 flex items-center justify-center text-muted">{file.error}</div>
      </div>
    )
  }

  // Handle image files
  if (isImageFile(filePath)) {
    return (
      <div className="h-full flex flex-col">
        <FileHeader path={filePath} size={file.size} squadId={squadId} />
        <div className="flex-1 overflow-auto flex items-center justify-center p-4 bg-[rgb(var(--syntax-image-bg))]">
          <SquadWorkspaceImageViewer squadId={squadId} filePath={filePath} />
        </div>
      </div>
    )
  }

  // Handle other binary files
  if (file.binary) {
    return (
      <div className="h-full flex flex-col">
        <FileHeader path={filePath} size={file.size} squadId={squadId} />
        <div className="flex-1 flex items-center justify-center text-muted">Binary file — cannot display</div>
      </div>
    )
  }

  const language = getLanguage(filePath)

  // Calculate line number width based on total lines
  const lineCount = file.content.split('\n').length
  const lineNumberDigits = String(lineCount).length

  return (
    <div className="h-full flex flex-col">
      <FileHeader path={filePath} size={file.size} language={language} squadId={squadId} />
      <div className="flex-1 overflow-auto min-w-0 [&_code_span:not(.linenumber)]:!inline">
        <SyntaxHighlighter
          language={language}
          style={syntaxTheme}
          showLineNumbers
          customStyle={{
            margin: 0,
            borderRadius: 0,
            minHeight: '100%',
            fontSize: '13px',
            lineHeight: '1.5',
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
    </div>
  )
}

function FileHeader({
  path,
  size,
  language,
  squadId,
}: {
  path: string
  size: number
  language?: string
  squadId: string
}) {
  const handleDownload = () => {
    const downloadUrl = getSquadWorkspaceDownloadUrl(squadId, path)
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
    <div className="flex items-center justify-between px-3 py-2 border-b border-th-border">
      <span className="text-sm font-mono text-secondary truncate" title={path}>
        {path}
      </span>
      <div className="flex items-center gap-3 text-xs text-muted shrink-0">
        {language && language !== 'text' && <span className="bg-surface-hover px-2 py-0.5 rounded">{language}</span>}
        <span>{formatSize(size)}</span>
        <button
          onClick={handleDownload}
          className="ficus-button p-1 text-muted hover:text-primary rounded hover:bg-surface-hover transition-colors"
          title="Download file"
        >
          <DownloadIcon className="w-4 h-4" />
        </button>
      </div>
    </div>
  )
}
