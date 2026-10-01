import { useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import clsx from 'clsx'
import { isWorkspaceVoiceRecipient, type Squad } from '@ficus/shared'
import type { InboxMessageResponse } from '../api/inbox'
import { apiUrl } from '../api/client'
import { MarkdownContent } from './MarkdownContent'
import { getWorkStreamLink } from '../lib/inboxWorkStreamLink'
import { useSquadSlugs } from '../hooks/useSquadSlugs'
import { ChevronDownIcon, ChevronRightIcon, WorkStreamIcon } from './icons'

interface MessageRowProps {
  message: InboxMessageResponse
  onMarkAsRead?: () => void
  squads?: Squad[]
  /** Compact mode for popup - shorter preview and inline metadata. */
  compact?: boolean
}

export function MessageRow({ message, onMarkAsRead, squads = [], compact = false }: MessageRowProps) {
  const [expanded, setExpanded] = useState(false)
  const { slugFor } = useSquadSlugs()
  const squad = message.senderAgent ? squads.find((s) => s.id === message.senderAgent?.squadId) : null
  const isUnread = !message.readAt
  const createdAt = timeAgo(new Date(message.createdAt))
  const workStreamLink = getWorkStreamLink(message.metadata ?? {})

  // Generate preview from content
  const preview = getMessagePreview(message.content, compact ? 80 : 120)

  return (
    // Both inbox surfaces use the same card geometry, independent of preview density.
    <div className={clsx('rounded-lg hover:bg-surface-hover/50 transition-colors', isUnread && 'bg-accent/5')}>
      {/* Header row - always visible */}
      <div
        className="relative flex items-start gap-3 cursor-pointer min-w-0 py-3.5 pl-6 pr-3"
        onClick={() => setExpanded(!expanded)}
      >
        {/* Unread indicator */}
        <span
          className={clsx(
            // Its own gutter, left of the text (which every section of the row lines up with, at pl-6).
            'absolute left-2.5 top-[1.3rem] w-1.5 h-1.5 rounded-full',
            isUnread ? 'bg-accent' : 'bg-transparent'
          )}
        />

        {/* Content area */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            {message.senderAgent ? (
              <Link
                to={
                  squad
                    ? `/squads/${slugFor(squad.id)}?agent=${message.senderAgent.id}`
                    : `/chat/${message.senderAgent.id}`
                }
                onClick={(e) => e.stopPropagation()}
                className="text-xs text-muted hover:text-accent-light"
              >
                {formatSender(message)}
              </Link>
            ) : (
              <span className="text-xs text-muted">{formatSender(message)}</span>
            )}

            {/* Squad badge */}
            {squad && (
              <Link
                to={`/squads/${slugFor(squad.id)}`}
                onClick={(e) => e.stopPropagation()}
                className="text-xs text-muted font-medium transition-opacity hover:opacity-80"
              >
                {squad.name}
              </Link>
            )}
          </div>

          {/* Subject or preview */}
          <div className="mt-1">
            {message.subject ? (
              <p
                className={clsx(
                  'font-medium text-primary',
                  compact ? 'text-xs truncate' : 'text-sm leading-relaxed line-clamp-2 break-words'
                )}
              >
                {message.subject}
              </p>
            ) : (
              !expanded && <p className={clsx('text-muted truncate', compact ? 'text-xs' : 'text-sm')}>{preview}</p>
            )}
            {message.subject && !expanded && <p className="text-xs text-muted truncate mt-0.5">{preview}</p>}
          </div>

          {!compact && (
            <div
              data-testid="inbox-row-meta-mobile"
              className="mt-1 flex items-center gap-3 text-xs text-muted md:hidden"
            >
              <span className="tabular-nums">{createdAt}</span>
              {isUnread && onMarkAsRead && (
                <>
                  <span aria-hidden="true">·</span>
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      onMarkAsRead()
                    }}
                    className="ficus-button -my-1 min-h-[32px] py-1 text-accent-light hover:underline"
                  >
                    Mark read
                  </button>
                </>
              )}
            </div>
          )}
        </div>

        <div className={clsx('items-start gap-3 shrink-0 mt-0.5', compact ? 'flex' : 'hidden md:flex')}>
          {/* Time */}
          <span className="text-xs text-placeholder tabular-nums shrink-0">{createdAt}</span>

          {/* Mark as read button (unread only) */}
          {isUnread && onMarkAsRead && (
            <button
              onClick={(e) => {
                e.stopPropagation()
                onMarkAsRead()
              }}
              className="ficus-button text-xs text-accent-light hover:underline shrink-0"
            >
              {compact ? 'Read' : 'Mark read'}
            </button>
          )}
        </div>

        {/* Expand/collapse chevron */}
        <button
          onClick={(e) => {
            e.stopPropagation()
            setExpanded(!expanded)
          }}
          className="ficus-button p-1 -mr-1 text-placeholder hover:text-secondary shrink-0 md:mr-0"
          aria-expanded={expanded}
          aria-label={expanded ? 'Collapse' : 'Expand'}
        >
          {expanded ? <ChevronDownIcon className="w-4 h-4" /> : <ChevronRightIcon className="w-4 h-4" />}
        </button>
      </div>

      {/* Attachment download links */}
      {message.attachments && message.attachments.length > 0 && (
        <div className="flex flex-wrap gap-2 pb-2 pl-6 pr-3">
          {message.attachments.map((att) => (
            <a
              key={att.id}
              href={apiUrl(`/inbox/attachments/${att.id}`)}
              download={att.filename}
              className="inline-flex items-center gap-1 rounded-md bg-surface-secondary px-2 py-1 text-xs text-accent-light hover:bg-surface-hover"
            >
              {att.filename}
            </a>
          ))}
        </div>
      )}

      {/* Expanded content */}
      {expanded && (
        <div className="pb-3 pt-0 pl-6 pr-3">
          {workStreamLink && (
            <Link
              to={workStreamLink}
              className="mb-2 inline-flex items-center gap-1.5 rounded-md bg-surface-secondary px-2 py-1 text-xs font-medium text-accent-light hover:bg-surface-hover"
            >
              <WorkStreamIcon className="w-3.5 h-3.5" />
              View work stream
            </Link>
          )}
          <div className={clsx('rounded-lg py-2 overflow-y-auto', compact ? 'max-h-48' : 'max-h-64')}>
            <MarkdownContent className="prose-sm">{message.content}</MarkdownContent>
          </div>
        </div>
      )}
    </div>
  )
}

/** Shared card spacing for the page and popup, including read messages. */
export function MessageList({ children }: { children: ReactNode }) {
  return <div className="space-y-1">{children}</div>
}

// --- Section Header ---

interface SectionHeaderProps {
  title: string
  count: number
  collapsible?: boolean
  collapsed?: boolean
  onToggle?: () => void
}

export function SectionHeader({ title, count, collapsible, collapsed, onToggle }: SectionHeaderProps) {
  const content = (
    <div className="flex items-center gap-2">
      {collapsible &&
        (collapsed ? (
          <ChevronRightIcon className="w-4 h-4 text-placeholder" />
        ) : (
          <ChevronDownIcon className="w-4 h-4 text-placeholder" />
        ))}
      <span className="text-sm font-semibold text-secondary">{title}</span>
      <span className="text-xs text-muted tabular-nums">{count}</span>
    </div>
  )

  if (collapsible && onToggle) {
    return (
      <button
        onClick={onToggle}
        aria-expanded={!collapsed}
        className={clsx(
          'ficus-button',
          'w-full rounded-lg pl-6 pr-3 py-2 hover:bg-surface-hover text-left focus-visible:outline-offset-[-2px]'
        )}
      >
        {content}
      </button>
    )
  }

  return <div className="pl-6 pr-3 py-2">{content}</div>
}

// --- Helper functions ---

export function formatSender(message: InboxMessageResponse): string {
  const senderMetadata = message.metadata?.sender as Record<string, string> | undefined
  const isWorkspaceVoiceSender = message.senderType === 'voice_assistant' && isWorkspaceVoiceRecipient(message.senderId)
  const name =
    message.senderAgent?.metadata?.name ||
    senderMetadata?.name ||
    (isWorkspaceVoiceSender ? 'Voice Workspace Agent' : '')
  const agentTypeName =
    senderMetadata?.agentTypeName ||
    senderMetadata?.agentTypeId ||
    (message.senderType === 'voice_assistant' ? 'voice_assistant' : '')
  const senderId = message.senderId
    ? `[${isWorkspaceVoiceSender ? message.senderId : message.senderId.slice(0, 8)}]`
    : ''
  return [name, agentTypeName ? `(${agentTypeName})` : '', senderId].filter(Boolean).join(' ') || message.senderType
}

export function timeAgo(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000)
  if (seconds < 60) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d ago`
  return date.toLocaleString()
}

export function getMessagePreview(content: string, maxLength: number): string {
  // Strip markdown formatting for preview
  let preview = content
    .replace(/```[\s\S]*?```/g, '[code]') // code blocks
    .replace(/`[^`]+`/g, '[code]') // inline code
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // links
    .replace(/[*_~]+/g, '') // bold/italic/strikethrough
    .replace(/#+\s*/g, '') // headers
    .replace(/>\s*/g, '') // blockquotes
    .replace(/[-*+]\s+/g, '') // list items
    .replace(/\n+/g, ' ') // newlines to spaces
    .trim()

  if (preview.length > maxLength) {
    preview = preview.substring(0, maxLength).trim() + '…'
  }

  return preview || 'No content'
}
