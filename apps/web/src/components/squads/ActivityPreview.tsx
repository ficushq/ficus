import { activityExternalHref } from './squadActivityView'
import type { ActivityPreviewSpan, Agent } from '@ficus/shared'
import type { ReactNode } from 'react'
import { parseEntityReference } from '../../lib/entityReference'
import { EntityReferenceLink } from '../EntityReferenceLink'

/** Only inline elements: never parse Markdown or mount the document renderer. */
export function ActivityPreview({
  spans,
  onOpenAgent,
}: {
  spans: ActivityPreviewSpan[]
  onOpenAgent?: (agent: Agent) => void
}) {
  return (
    <>
      {spans.map((span, index) => {
        let content: ReactNode = span.text
        if (span.code) content = <code className="rounded bg-pill px-0.5 font-mono text-[0.95em]">{content}</code>
        if (span.italic) content = <em>{content}</em>
        if (span.bold) content = <strong>{content}</strong>
        const reference = parseEntityReference(span.href)
        const external = span.href && activityExternalHref(span.href)
        if (reference)
          content = (
            <EntityReferenceLink reference={reference} preloadOnVisible={false} onOpenAgent={onOpenAgent}>
              {content}
            </EntityReferenceLink>
          )
        else if (external)
          content = (
            <a
              href={external}
              target="_blank"
              rel="noopener noreferrer"
              className="text-accent-light underline underline-offset-2"
            >
              {content}
            </a>
          )
        return (
          <span key={index} className={reference || external ? 'pointer-events-auto' : undefined}>
            {content}
          </span>
        )
      })}
    </>
  )
}
