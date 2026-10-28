import clsx from 'clsx'
import type { ReactNode } from 'react'
import { MarkdownContent } from './MarkdownContent'

/** The extension of a file name, lower-cased; empty when it has none. */
function fileExtension(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

function isMarkdownFile(name: string): boolean {
  const ext = fileExtension(name)
  return ext === 'md' || ext === 'markdown'
}

const LANGUAGES: Record<string, string> = {
  ts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  jsx: 'jsx',
  mjs: 'javascript',
  cjs: 'javascript',
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
  zsh: 'bash',
  html: 'html',
  css: 'css',
  csv: 'csv',
  diff: 'diff',
  patch: 'diff',
}

/** The highlighter language for a file name, `text` when unknown. */
function fileLanguage(name: string): string {
  return LANGUAGES[fileExtension(name)] ?? 'text'
}

type FilePreviewProps = {
  fileName: string
  /** Let the preview grow and scroll inside its parent (a modal body); off where the parent already scrolls. */
  scroll?: boolean
} & (
  { kind: 'text'; content: string } | { kind: 'image'; image: ReactNode } | { kind: 'unavailable'; children: ReactNode }
)

/**
 * The one inline file viewer: markdown as a reading document, other text as a highlighted code block,
 * images on the image backdrop, and a message (with any action the caller offers) for everything else.
 * Callers fetch the bytes; this only decides how they read.
 */
export function FilePreview(props: FilePreviewProps) {
  const { fileName, scroll } = props
  if (props.kind === 'image')
    return (
      <div
        className={clsx(
          scroll && 'grow overflow-auto',
          'flex items-center justify-center p-4 bg-[rgb(var(--syntax-image-bg))] min-h-[200px]'
        )}
      >
        {props.image}
      </div>
    )
  if (props.kind === 'unavailable')
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-12 text-center text-muted">
        {props.children}
      </div>
    )
  return (
    <div className={clsx(scroll && 'grow overflow-auto')}>
      {isMarkdownFile(fileName) ? (
        <MarkdownContent variant="document">{props.content}</MarkdownContent>
      ) : (
        <MarkdownContent>{'```' + fileLanguage(fileName) + '\n' + props.content + '\n```'}</MarkdownContent>
      )}
    </div>
  )
}
