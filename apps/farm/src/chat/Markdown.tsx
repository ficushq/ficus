import clsx from 'clsx'
import type { ComponentProps } from 'react'
import ReactMarkdown, { defaultUrlTransform, type Components } from 'react-markdown'
import { parseEntityReference } from '@ficus/shared'
import { FarmRefChip } from '../multiplayer/MessageBody'
import remarkGfm from 'remark-gfm'

const plugins = [remarkGfm]

function Link({ children, node: _node, ...props }: ComponentProps<'a'> & { node?: unknown }) {
  // A work stream or agent reference ([#323](ficus:ws:323)) is a chip that takes you to it on the farm.
  const reference = parseEntityReference(props.href)
  if (reference) return <FarmRefChip farmRef={reference} />
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

/** Entity references survive (they become chips); other URLs are made safe as usual. */
const keepReferences = (url: string) => (parseEntityReference(url) ? url : defaultUrlTransform(url))

/** Chat markdown (GFM), like the web's MarkdownContent; work stream and agent links are farm chips. */
export function Markdown({ children, className }: { children: string; className?: string }) {
  return (
    <div className={clsx('g-md', className)}>
      <ReactMarkdown remarkPlugins={plugins} components={components} urlTransform={keepReferences}>
        {children}
      </ReactMarkdown>
    </div>
  )
}
