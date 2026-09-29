import { useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { ChevronIcon } from '../icons'
import type { RenderItem } from '@ficus/client-react'
import { extractInboxBodies, type DeliveryMode, type Message, type MessageMetadata } from '@ficus/shared'
import { MessageBlocks } from './MessageBlocks'
import { Markdown } from './Markdown'

const LONG_HUMAN_MESSAGE_LIMIT = 1600
const INBOX_BODY_LIMIT = 280

type Summary = NonNullable<MessageMetadata['inboxMessageSummaries']>[number]

function senderName(summary: Summary): string {
  if (summary.senderDisplay) return summary.senderDisplay
  if (summary.senderId) return `${summary.senderId} ${summary.senderType}`
  return summary.senderType.replace(/_/g, ' ')
}

function Collapsible({ text, limit, className }: { text: string; limit: number; className?: string }) {
  const [expanded, setExpanded] = useState(false)
  const long = text.length > limit
  const visible = long && !expanded ? `${text.slice(0, limit).trimEnd()}…` : text
  return (
    <div className={className}>
      <Markdown>{visible}</Markdown>
      {long && (
        <button type="button" className="g-chat-link" aria-expanded={expanded} onClick={() => setExpanded((v) => !v)}>
          {expanded ? 'Show less' : 'Show more'}
        </button>
      )}
    </div>
  )
}

function ImagesNote({ count }: { count: number }) {
  return count > 0 ? (
    <p className="g-chat-note">
      {count} image{count === 1 ? '' : 's'} attached (open in Ficus to view)
    </p>
  ) : null
}

/** Mail another agent or a person sent in; rendered as a card, not a speech bubble. */
function InboxDelivery({ content, metadata }: { content: string; metadata: MessageMetadata }) {
  const summaries = metadata.inboxMessageSummaries ?? []
  const count = summaries.length || metadata.inboxMessageIds?.length || 1
  const interrupt = (metadata.inboxDeliveryMode ?? metadata.deliveryMode) === 'steer'
  const title = summaries.length === 1 ? `Mail from ${senderName(summaries[0])}` : `${count} letters delivered`
  const bodies = extractInboxBodies(content)
  return (
    <div className="g-chat-mail">
      <p className="g-chat-mail-title">
        <span aria-hidden="true">✉</span> {title}
        <span className={clsx('g-chat-tag', interrupt ? 'g-tag-interrupt' : 'g-tag-follow')}>
          {interrupt ? 'Interrupt' : 'Follow up'}
        </span>
      </p>
      <ImagesNote count={metadata.imageIds?.length ?? 0} />
      {summaries.length > 0 ? (
        summaries.map((summary, i) => (
          <div key={summary.id} className="g-chat-mail-item">
            {summary.subject && <p className="g-chat-mail-subject">{summary.subject}</p>}
            <Collapsible
              text={bodies.length === summaries.length ? bodies[i] : summary.preview}
              limit={INBOX_BODY_LIMIT}
            />
          </div>
        ))
      ) : (
        <Collapsible text={bodies.join('\n\n---\n\n')} limit={INBOX_BODY_LIMIT} />
      )}
    </div>
  )
}

function MonitorRow({ content, metadata }: { content: string; metadata: MessageMetadata }) {
  const [expanded, setExpanded] = useState(false)
  const monitor = metadata.monitor
  const label = monitor?.label ?? 'monitor'
  if ((monitor?.kind ?? 'lines') !== 'lines') {
    return (
      <p className="g-chat-monitor">
        <span aria-hidden="true">📟</span> {content}
      </p>
    )
  }
  const lines = monitor?.lineCount
  return (
    <div className="g-chat-monitor">
      <button
        type="button"
        className="g-chat-row-toggle"
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
      >
        <ChevronIcon className={clsx('g-chevron', expanded && 'g-open')} />
        <span>
          Monitor “{label}”{lines !== undefined ? ` · ${lines} new line${lines === 1 ? '' : 's'}` : ''}
        </span>
      </button>
      {expanded && <pre className="g-chat-code">{content.split('\n').slice(1).join('\n')}</pre>}
    </div>
  )
}

function HumanContent({ content, metadata }: { content: string; metadata: MessageMetadata | null | undefined }) {
  if (metadata?.source === 'monitor') return <MonitorRow content={content} metadata={metadata} />
  if (metadata?.source === 'inbox') return <InboxDelivery content={content} metadata={metadata} />
  return (
    <>
      <ImagesNote count={metadata?.imageIds?.length ?? 0} />
      <Collapsible text={content} limit={LONG_HUMAN_MESSAGE_LIMIT} />
    </>
  )
}

const automated = (metadata: MessageMetadata | null | undefined) =>
  metadata?.source === 'inbox' || metadata?.source === 'monitor'

function SystemRow({ text }: { text: string }) {
  return <p className="g-chat-system">{text.replace(/^\[System\]\s*/, '')}</p>
}

function HumanRow({ message, senderLabel }: { message: Message; senderLabel?: string }) {
  return (
    <div className={clsx('g-chat-msg g-chat-human', automated(message.metadata) && 'g-automated')}>
      {senderLabel && <p className="g-chat-sender">{senderLabel}</p>}
      <div className="g-chat-bubble">
        <HumanContent content={message.content} metadata={message.metadata} />
      </div>
    </div>
  )
}

function PendingRow({
  content,
  status,
  queued,
  deliveryMode,
  metadata,
  onRetry,
}: {
  content: string
  status: 'sending' | 'queued' | 'failed'
  queued?: boolean
  deliveryMode?: DeliveryMode
  metadata?: MessageMetadata | null
  onRetry?: () => void
}) {
  const auto = automated(metadata)
  return (
    <div
      className={clsx('g-chat-msg g-chat-human g-pending', auto && 'g-automated', status === 'failed' && 'g-failed')}
    >
      <div className="g-chat-bubble">
        {deliveryMode && !auto && queued && (
          <p className="g-chat-queued-tag">{deliveryMode === 'steer' ? '⚡ Interrupt' : '📋 Follow up'}</p>
        )}
        <HumanContent content={content} metadata={metadata} />
        {status === 'sending' && !auto && <p className="g-chat-status">Sending…</p>}
        {status === 'failed' && (
          <p className="g-chat-status">
            Not sent.{' '}
            {onRetry && (
              <button type="button" className="g-chat-link" onClick={onRetry}>
                Retry
              </button>
            )}
          </p>
        )}
      </div>
    </div>
  )
}

function Working({ label }: { label: string }) {
  return (
    <div className="g-chat-working" role="status">
      <span className="g-chat-dots" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      <span>{label}</span>
    </div>
  )
}

export interface TranscriptProps {
  items: RenderItem[]
  viewingUserId?: string
  hideInboxMessages?: boolean
  workingLabel: string
  onRetry: (clientId: string) => void
  /** Drawn under an agent's reply (e.g. the Assistant's task updates it covers). */
  renderReplyFooter?: (item: Extract<RenderItem, { kind: 'persisted' }>) => ReactNode
}

/** The conversation rows, one per RenderItem, in the order combine() produced. */
export function Transcript({
  items,
  viewingUserId,
  hideInboxMessages,
  workingLabel,
  onRetry,
  renderReplyFooter,
}: TranscriptProps) {
  let previousSender: string | undefined
  return (
    <>
      {items.map((item) => {
        if (
          hideInboxMessages &&
          ((item.kind === 'pending' && item.metadata?.source === 'inbox') ||
            (item.kind === 'persisted' && item.message.role === 'human' && item.message.metadata?.source === 'inbox'))
        )
          return null

        switch (item.kind) {
          case 'persisted': {
            const m = item.message
            if (m.content.startsWith('[System]')) {
              previousSender = undefined
              return <SystemRow key={item.id} text={m.content} />
            }
            if (m.role === 'human') {
              const sender = m.metadata?.sender
              const label =
                sender && sender.userId !== viewingUserId && sender.userId !== previousSender ? sender.name : undefined
              previousSender = sender?.userId
              return <HumanRow key={item.id} message={m} senderLabel={label} />
            }
            previousSender = undefined
            return (
              <div key={item.id} className="g-chat-msg g-chat-agent">
                {item.blocks.length > 0 ? <MessageBlocks blocks={item.blocks} /> : <Markdown>{m.content}</Markdown>}
                {renderReplyFooter?.(item)}
              </div>
            )
          }
          case 'streaming':
            previousSender = undefined
            return (
              <div key={item.id} className="g-chat-msg g-chat-agent" aria-busy={item.status === 'streaming'}>
                <MessageBlocks blocks={item.blocks} streaming={item.status === 'streaming'} />
                {item.status === 'interrupted' && <p className="g-chat-note">Interrupted</p>}
              </div>
            )
          case 'pending':
            return (
              <PendingRow
                key={item.id}
                content={item.content}
                status={item.status}
                queued={item.queued}
                deliveryMode={item.deliveryMode}
                metadata={item.metadata}
                onRetry={item.status === 'failed' ? () => onRetry(item.id) : undefined}
              />
            )
          case 'system':
            previousSender = undefined
            return <SystemRow key={item.id} text={item.text} />
          case 'working':
            return (
              <Working
                key={item.id}
                label={item.waitingFor === 'sandbox' ? 'Waiting for the sandbox to start…' : workingLabel}
              />
            )
          case 'queued':
            return (
              <p key={item.id} className="g-chat-system g-chat-maintenance" role="status">
                {item.label}
              </p>
            )
        }
      })}
    </>
  )
}
