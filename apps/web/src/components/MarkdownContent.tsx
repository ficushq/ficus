import { remarkWorkStreamReferences } from '../lib/remarkWorkStreamReferences'
import clsx from 'clsx'
import ReactMarkdown, { Components, defaultUrlTransform } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter'
import { syntaxTheme } from '../theme/syntax'
import { Children, type ComponentProps } from 'react'
import remarkFrontmatter from 'remark-frontmatter'
import { remarkAgentFileReferences } from '../lib/remarkAgentFileReferences'
import { parseEntityReference } from '../lib/entityReference'
import { FileIcon } from './icons'
import { EntityReferenceLink } from './EntityReferenceLink'

const plugins = [
  remarkGfm,
  remarkWorkStreamReferences,
  // parse and hide frontmatter
  remarkFrontmatter,
]

export function MarkdownContent({
  children,
  variant = 'assistant',
  className,
  agentId,
  compactPullRequestLinks = false,
}: {
  children: string
  /**
   * `document` is for embedded documents (descriptions, handoffs, proposals): headings sit on a
   * reading scale instead of prose's display sizes, so a `# Title` never outshines the surface title.
   */
  variant?: 'assistant' | 'human' | 'rewind' | 'document'
  className?: string
  agentId?: string
  /** Shorten bare GitHub PR URLs in compact action summaries, preserving explicit labels. */
  compactPullRequestLinks?: boolean
}) {
  return (
    <div
      className={clsx(
        'prose prose-sm max-w-none',
        variant === 'human' ? 'prose-on-accent' : 'prose-gray dark:prose-invert',
        variant === 'document' && 'prose-document',
        className
      )}
    >
      <ReactMarkdown
        urlTransform={(url) => (parseEntityReference(url) ? url : defaultUrlTransform(url))}
        remarkPlugins={agentId ? [...plugins, [remarkAgentFileReferences, { agentId }]] : plugins}
        components={{
          a: compactPullRequestLinks ? CompactPullRequestLink : AttachmentOrRemoteLink,
          pre: Pre,
          code: Code,
          table: Table,
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  )
}

function CompactPullRequestLink({ children, href, ...props }: ComponentProps<'a'>) {
  const text = Children.toArray(children)
  const number = href?.match(/^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/(\d+)\/?(?:[?#].*)?$/)?.[1]
  const isBareUrl = text.length === 1 && text[0] === href
  return (
    <AttachmentOrRemoteLink {...props} href={href} title={number && isBareUrl ? href : props.title}>
      {number && isBareUrl ? `PR #${number}` : children}
    </AttachmentOrRemoteLink>
  )
}

function AttachmentOrRemoteLink({ children, ...props }: ComponentProps<'a'>) {
  const reference = parseEntityReference(props.href)
  if (reference) return <EntityReferenceLink reference={reference}>{children}</EntityReferenceLink>

  if ((props as Record<string, unknown>)['data-agent-file-id']) {
    return (
      <a
        {...props}
        className="not-prose inline-flex items-center rounded border border-th-border px-2 py-1 text-sm"
        download
      >
        <FileIcon className="mr-1 h-4 w-4" />
        {children}
      </a>
    )
  }
  return (
    <a {...props} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  )
}

function Pre({ children, ...props }: ComponentProps<'pre'>) {
  return (
    <pre {...props} className="!bg-transparent !p-0">
      {children}
    </pre>
  )
}

function Code({ className, children, ...props }: ComponentProps<'code'>) {
  const match = /language-(\w+)/.exec(className || '')
  const codeString = String(children).replace(/\n$/, '')

  // Check if it's a code block (has language) vs inline code
  if (match) {
    return (
      <SyntaxHighlighter style={syntaxTheme} language={match[1]} PreTag="div">
        {codeString}
      </SyntaxHighlighter>
    )
  }

  // Inline code
  return (
    <code className={clsx('bg-code-bg text-code-text px-1 py-0.5 rounded', className)} {...props}>
      {children}
    </code>
  )
}

// Scroll tables horizontally if necessary.
const Table: Components['table'] = ({ children, className, ...props }) => (
  <div className="overflow-x-auto px-2">
    <table {...props} className={clsx('ficus-table', '!min-w-max !my-2', className)}>
      {children}
    </table>
  </div>
)
