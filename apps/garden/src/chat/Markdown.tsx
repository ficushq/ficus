import clsx from 'clsx'
import type { ComponentProps } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'

const plugins = [remarkGfm]

function Link({ children, node: _node, ...props }: ComponentProps<'a'> & { node?: unknown }) {
  return (
    <a {...props} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  )
}

function Table({ children, node: _node, ...props }: ComponentProps<'table'> & { node?: unknown }) {
  return (
    <div className="g-md-table">
      <table {...props}>{children}</table>
    </div>
  )
}

const components: Components = { a: Link, table: Table }

/** Chat markdown (GFM), like the web's MarkdownContent minus its web-only link resolvers. */
export function Markdown({ children, className }: { children: string; className?: string }) {
  return (
    <div className={clsx('g-md', className)}>
      <ReactMarkdown remarkPlugins={plugins} components={components}>
        {children}
      </ReactMarkdown>
    </div>
  )
}
