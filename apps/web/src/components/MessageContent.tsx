import { useToolRenderers } from '../lib/ToolRenderersContext'
import clsx from 'clsx'
import { ToolInlineActions } from './ToolInlineActions'
import type { ToolInlineAction } from '../lib/tool-inline-actions'
import { useState, useEffect, useRef, useMemo } from 'react'
import { MarkdownContent } from './MarkdownContent'
import { extractInboxBodies } from '@ficus/shared'
import { parseMessageContent } from '../lib/message-parser'
import {
  isWorkspaceVoiceRecipient,
  type MessageMetadata,
  type MessageToolCall,
  type ContentBlock,
  type MonitorMessageKind,
} from '@ficus/shared'
import { ToolSummary, ToolArgsView, ToolResultView } from '../lib/tool-renderers'
import { ChevronRightIcon, MailIcon, WorkStreamIcon } from './icons'
import { WorkStreamViewModal } from './WorkStreamViewModal'
import { useImageSrcs } from '../hooks/useImageSrcs'

const LONG_HUMAN_MESSAGE_LIMIT = 1600

// Type for grouped blocks - either a single block that renders as-is, or a group of consecutive tool/thinking blocks
type BlockGroup = { type: 'single'; block: ContentBlock } | { type: 'group'; blocks: ContentBlock[] }

/**
 * Groups consecutive non-text blocks (thinking and tool_use) into collapsible groups.
 * Text blocks break groups and are rendered directly.
 */
function groupConsecutiveBlocks(blocks: ContentBlock[]): BlockGroup[] {
  const result: BlockGroup[] = []
  let currentGroup: ContentBlock[] = []

  const flushGroup = () => {
    if (currentGroup.length === 0) return
    if (currentGroup.length === 1) {
      result.push({ type: 'single', block: currentGroup[0] })
    } else {
      result.push({ type: 'group', blocks: [...currentGroup] })
    }
    currentGroup = []
  }

  for (const block of blocks) {
    if (block.type === 'text') {
      // Text blocks break groups
      flushGroup()
      result.push({ type: 'single', block })
    } else {
      // thinking or tool_use - accumulate into current group
      currentGroup.push(block)
    }
  }

  // Flush any remaining group
  flushGroup()

  return result
}

/**
 * Generates a human-readable summary for a group of blocks
 */
function getGroupSummary(blocks: ContentBlock[]): string {
  const toolCount = blocks.filter((b) => b.type === 'tool_use').length
  const thinkingCount = blocks.filter((b) => b.type === 'thinking').length

  const parts: string[] = []
  if (toolCount > 0) {
    parts.push(`${toolCount} tool${toolCount !== 1 ? 's' : ''}`)
  }
  if (thinkingCount > 0) {
    parts.push(`${thinkingCount} thinking`)
  }

  return parts.join(' • ')
}

interface AssistantMessageContentProps {
  content: string
  metadata?: MessageMetadata | null
  showRaw?: boolean
  agentId?: string
  onToolInlineAction?: (action: ToolInlineAction) => void
}

export function AssistantMessageContent({
  content,
  metadata,
  showRaw,
  agentId,
  onToolInlineAction,
}: AssistantMessageContentProps) {
  const blocks = metadata?.content

  if (blocks && blocks.length > 0) {
    return (
      <OrderedBlocksRenderer
        blocks={blocks}
        showRaw={showRaw}
        agentId={agentId}
        onToolInlineAction={onToolInlineAction}
      />
    )
  }

  // No metadata — render plain text content
  const segments = parseMessageContent(content)
  return (
    <div className="space-y-2 [&>*:first-child]:mt-0 [&>*:first-child>*:first-child]:mt-0 [&>*:last-child]:mb-0 [&>*:last-child>*:last-child]:mb-0">
      {segments.map((segment, i) => {
        if (segment.type === 'text') {
          return showRaw ? (
            <pre key={i} className="whitespace-pre-wrap font-mono text-sm">
              {segment.content}
            </pre>
          ) : (
            <MarkdownContent key={i} agentId={agentId}>
              {segment.content}
            </MarkdownContent>
          )
        }
        if (segment.type === 'step_complete') {
          return <StepCompleteBlock key={i} message={segment.message} />
        }
        if (segment.type === 'rewind') {
          return <RewindBlock key={i} step={segment.step} message={segment.message} showRaw={showRaw} />
        }
        return null
      })}
    </div>
  )
}

/**
 * Renders parsed text content, handling magic strings (step_complete, rewind, etc.)
 * Shared between OrderedBlocksRenderer (persisted messages) and StreamingBlocksRenderer (live stream).
 */
export function ParsedTextContent({
  content,
  showRaw,
  agentId,
}: {
  content: string
  showRaw?: boolean
  agentId?: string
}) {
  const segments = parseMessageContent(content)
  return (
    <div className="space-y-2">
      {segments.map((segment, i) => {
        if (segment.type === 'text') {
          return showRaw ? (
            <pre key={i} className="whitespace-pre-wrap font-mono text-sm">
              {segment.content}
            </pre>
          ) : (
            <MarkdownContent key={i} agentId={agentId}>
              {segment.content}
            </MarkdownContent>
          )
        }
        if (segment.type === 'step_complete') {
          return <StepCompleteBlock key={i} message={segment.message} />
        }
        if (segment.type === 'rewind') {
          return <RewindBlock key={i} step={segment.step} message={segment.message} showRaw={showRaw} />
        }
        return null
      })}
    </div>
  )
}

/**
 * Renders human message content with optional images.
 */
export function HumanMessageContent({
  content,
  metadata,
  showRaw,
  agentId,
}: {
  content: string
  metadata?: MessageMetadata | null
  showRaw?: boolean
  agentId?: string
}) {
  if (metadata?.source === 'monitor') {
    return <MonitorMessageRow content={content} metadata={metadata} showRaw={showRaw} />
  }

  if (metadata?.source === 'inbox') {
    return <InboxDeliveryMessageCard content={content} metadata={metadata} showRaw={showRaw} />
  }

  return (
    <StandardHumanMessageContent content={content} imageIds={metadata?.imageIds} showRaw={showRaw} agentId={agentId} />
  )
}

function StandardHumanMessageContent({
  content,
  imageIds,
  showRaw,
  agentId,
}: {
  content: string
  imageIds?: string[]
  showRaw?: boolean
  agentId?: string
}) {
  const shouldCollapse = content.length > LONG_HUMAN_MESSAGE_LIMIT
  const [expanded, setExpanded] = useState(false)
  const visibleContent =
    shouldCollapse && !expanded ? `${content.slice(0, LONG_HUMAN_MESSAGE_LIMIT).trimEnd()}…` : content

  return (
    <>
      {imageIds && imageIds.length > 0 && <ImageAttachments imageIds={imageIds} />}
      {showRaw ? (
        <pre className="whitespace-pre-wrap font-mono text-sm">{visibleContent}</pre>
      ) : (
        <MarkdownContent variant="human" agentId={agentId}>
          {visibleContent}
        </MarkdownContent>
      )}
      {shouldCollapse && (
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          className="ficus-button mt-1 text-xs font-medium underline underline-offset-2 opacity-85 hover:opacity-100"
          aria-expanded={expanded}
        >
          {expanded ? 'Show less' : 'Show more'}
        </button>
      )}
    </>
  )
}

function ImageAttachments({ imageIds, variant = 'standard' }: { imageIds: string[]; variant?: 'standard' | 'inbox' }) {
  const srcs = useImageSrcs(imageIds)

  if (variant === 'inbox') {
    return (
      <div className="mt-3 flex max-w-full gap-2 overflow-x-auto pb-1">
        {imageIds.map((id) => (
          <a key={id} href={srcs[id]} target="_blank" rel="noopener noreferrer" className="block shrink-0">
            <img
              src={srcs[id]}
              alt="Inbox attachment"
              className="h-20 w-20 rounded border border-status-progress-300/40 object-cover transition-colors hover:border-status-progress-300 dark:border-status-progress-400/30"
              loading="lazy"
            />
          </a>
        ))}
      </div>
    )
  }

  return (
    <div className="flex flex-wrap gap-2 mb-2">
      {imageIds.map((id) => (
        <a key={id} href={srcs[id]} target="_blank" rel="noopener noreferrer" className="block">
          <img
            src={srcs[id]}
            alt="Attached image"
            className="max-h-40 max-w-full rounded border border-status-progress-400/30 hover:border-status-progress-300 transition-colors"
            loading="lazy"
          />
        </a>
      ))}
    </div>
  )
}

function monitorTerminalStyle(
  kind: MonitorMessageKind,
  exitCode?: number | null
): {
  border: string
  bg: string
  text: string
  icon: string
} {
  switch (kind) {
    case 'failed':
      return {
        border: 'border-status-danger-200 dark:border-status-danger-800',
        bg: 'bg-status-danger-50/50 dark:bg-status-danger-900/20',
        text: 'text-status-danger-700 dark:text-status-danger-300',
        icon: '✗',
      }
    case 'exited':
      return exitCode && exitCode !== 0
        ? {
            border: 'border-status-attention-200 dark:border-status-attention-800',
            bg: 'bg-status-attention-50/50 dark:bg-status-attention-900/20',
            text: 'text-status-attention-700 dark:text-status-attention-300',
            icon: '✗',
          }
        : {
            border: 'border-status-success-200 dark:border-status-success-800',
            bg: 'bg-status-success-50/50 dark:bg-status-success-900/20',
            text: 'text-status-success-700 dark:text-status-success-300',
            icon: '✓',
          }
    case 'timed-out':
      return {
        border: 'border-status-attention-200 dark:border-status-attention-800',
        bg: 'bg-status-attention-50/50 dark:bg-status-attention-900/20',
        text: 'text-status-attention-700 dark:text-status-attention-300',
        icon: '⏱',
      }
    case 'overload':
      return {
        border: 'border-status-danger-200 dark:border-status-danger-800',
        bg: 'bg-status-danger-50/50 dark:bg-status-danger-900/20',
        text: 'text-status-danger-700 dark:text-status-danger-300',
        icon: '⚠',
      }
    case 'canceled':
    default:
      return { border: 'border-th-border', bg: '', text: 'text-secondary', icon: '⊘' }
  }
}

function MonitorMessageRow({
  content,
  metadata,
  showRaw,
}: {
  content: string
  metadata: MessageMetadata
  showRaw?: boolean
}) {
  const monitor = metadata.monitor
  const kind = monitor?.kind ?? 'lines'
  const label = monitor?.label ?? 'monitor'
  const [expanded, setExpanded] = useState(false)

  if (kind === 'lines') {
    const count = monitor?.lineCount
    // The first content line is the descriptive header (shown in the row); the rest are the batched lines.
    const body = content.split('\n').slice(1).join('\n')
    return (
      <div className="border border-th-border rounded-md text-xs">
        <button
          onClick={() => setExpanded(!expanded)}
          className="ficus-button w-full flex items-center gap-1.5 px-2.5 py-1.5 text-secondary hover:bg-surface-hover transition-colors text-left min-w-0 rounded-md"
        >
          <span className={clsx('text-[10px] transition-transform shrink-0', expanded && 'rotate-90')}>&#9654;</span>
          <span className="shrink-0" aria-label="Monitor">
            &#128223;
          </span>
          <span className="font-medium shrink-0">Monitor &quot;{label}&quot;</span>
          {count !== undefined && (
            <span className="text-secondary truncate">
              · {count} new line{count === 1 ? '' : 's'}
            </span>
          )}
        </button>
        <div className={clsx('border-t border-th-border px-2.5 py-2', !expanded && 'hidden')}>
          <pre className="whitespace-pre-wrap font-mono text-[11px] text-secondary">{body}</pre>
        </div>
      </div>
    )
  }

  const style = monitorTerminalStyle(kind, monitor?.exitCode)
  return (
    <div
      className={clsx(
        'border rounded-md text-xs px-2.5 py-1.5 flex items-start gap-1.5',
        style.border,
        style.bg,
        style.text
      )}
    >
      <span className="shrink-0">{style.icon}</span>
      <span className="shrink-0" aria-label="Monitor">
        &#128223;
      </span>
      {showRaw ? (
        <pre className="whitespace-pre-wrap font-mono text-xs font-medium">{content}</pre>
      ) : (
        <span className="font-medium">{content}</span>
      )}
    </div>
  )
}

function InboxDeliveryMessageCard({
  content,
  metadata,
  showRaw,
}: {
  content: string
  metadata: MessageMetadata
  showRaw?: boolean
}) {
  const summaries = metadata.inboxMessageSummaries ?? []
  const imageIds = metadata.imageIds ?? []
  const count = summaries.length || metadata.inboxMessageIds?.length || 1
  const mode = metadata.inboxDeliveryMode ?? metadata.deliveryMode
  const isInterrupt = mode === 'steer'
  const title =
    summaries.length === 1
      ? `Inbox message from ${formatInboxSender(summaries[0])}`
      : `Inbox delivered ${count} messages`
  // One body per delivered message, recovered from the delivery prompt itself
  // (the persisted summaries only carry a 160-char preview). Index-aligned with
  // `summaries`; a count mismatch falls back to the summary preview.
  const bodies = extractInboxBodies(content)
  const [wsOpen, setWsOpen] = useState<{ workStreamId: string; squadId: string } | null>(null)

  return (
    // Right-aligned (the parent row already justifies inbox messages to the end): a subtle title
    // above a single card (no nested cards). Card color kept — deliberately not glass.
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-1.5 text-[11px] font-medium text-muted">
        <MailIcon className="h-3.5 w-3.5 shrink-0" />
        <span>{title}</span>
        <span
          className={clsx(
            'rounded-full px-1.5 py-0.5 text-[10px] font-medium',
            isInterrupt
              ? 'bg-status-external-wait-100 text-status-external-wait-700 dark:bg-status-external-wait-950/60 dark:text-status-external-wait-300'
              : 'bg-status-progress-100 text-status-progress-700 dark:bg-status-progress-900/60 dark:text-status-progress-300'
          )}
        >
          {isInterrupt ? 'Interrupt' : 'Follow up'}
        </span>
      </div>

      <div className="w-full rounded-lg border border-status-progress-300/40 bg-status-progress-50/70 p-3 text-left text-sm text-status-progress-950 dark:border-status-progress-400/20 dark:bg-status-progress-950/30 dark:text-status-progress-100">
        {imageIds.length > 0 && <ImageAttachments imageIds={imageIds} variant="inbox" />}

        {showRaw ? (
          <pre className="max-h-60 overflow-auto whitespace-pre-wrap rounded-md bg-chrome-paper/70 p-2 font-mono text-[11px] text-secondary dark:bg-chrome-scrim/20">
            {content}
          </pre>
        ) : summaries.length > 0 ? (
          <div className="space-y-3">
            {summaries.map((summary, index) => (
              <div key={summary.id}>
                {summary.subject && <div className="font-medium text-primary">{summary.subject}</div>}
                <InboxCardBody
                  body={bodies.length === summaries.length ? bodies[index] : summary.preview}
                  className={summary.subject ? 'mt-1' : undefined}
                />
                {summary.workStreamId && summary.squadId && (
                  <button
                    type="button"
                    onClick={() => setWsOpen({ workStreamId: summary.workStreamId!, squadId: summary.squadId! })}
                    className="ficus-button mt-2 inline-flex items-center gap-1 text-xs font-medium text-status-progress-700 hover:text-status-progress-900 dark:text-status-progress-300 dark:hover:text-status-progress-200"
                  >
                    <WorkStreamIcon className="h-3.5 w-3.5 shrink-0" />
                    View work stream
                  </button>
                )}
              </div>
            ))}
          </div>
        ) : (
          <InboxCardBody body={bodies.join('\n\n---\n\n')} />
        )}
      </div>

      {wsOpen && (
        <WorkStreamViewModal
          workStreamId={wsOpen.workStreamId}
          squadId={wsOpen.squadId}
          onClose={() => setWsOpen(null)}
        />
      )}
    </div>
  )
}

/** Characters of an inbox body shown before the Show more toggle appears. */
const INBOX_BODY_COLLAPSED_LIMIT = 280

/**
 * The delivered message body as markdown, truncated with a Show more / Show less
 * toggle — the same affordance the rest of the app uses for long text, and what
 * replaced the old "Full prompt" raw-text dropdown (the framing the agent sees is
 * noise to a human; the body is the message).
 */
function InboxCardBody({ body, className }: { body: string; className?: string }) {
  const shouldCollapse = body.length > INBOX_BODY_COLLAPSED_LIMIT
  const [expanded, setExpanded] = useState(false)
  const visible = shouldCollapse && !expanded ? `${body.slice(0, INBOX_BODY_COLLAPSED_LIMIT).trimEnd()}…` : body
  return (
    <div className={className}>
      <MarkdownContent className="prose-sm text-secondary">{visible}</MarkdownContent>
      {shouldCollapse && (
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
          className="ficus-button mt-1 text-xs font-medium text-status-progress-700 underline decoration-status-progress-700/30 underline-offset-2 hover:text-status-progress-900 hover:decoration-status-progress-700/70 dark:text-status-progress-300 dark:hover:text-status-progress-200"
        >
          {expanded ? 'Show less' : 'Show more'}
        </button>
      )}
    </div>
  )
}

function formatInboxSender(summary: NonNullable<MessageMetadata['inboxMessageSummaries']>[number]): string {
  if (summary.senderDisplay) return summary.senderDisplay
  if (summary.senderType === 'voice_assistant') {
    if (isWorkspaceVoiceRecipient(summary.senderId)) return 'Voice Workspace Agent (voice_assistant) [workspace]'
    return `${summary.senderId ?? 'voice assistant'} voice`
  }
  if (summary.senderId) {
    return `${summary.senderId} ${summary.senderType}`
  }
  return summary.senderType.replace(/_/g, ' ')
}

/**
 * Renders ordered content blocks (new format) with interleaved thinking/tool calls/text.
 * Consecutive tool/thinking blocks are grouped into collapsible sections.
 */
function OrderedBlocksRenderer({
  blocks,
  showRaw,
  agentId,
  onToolInlineAction,
}: {
  blocks: ContentBlock[]
  showRaw?: boolean
  agentId?: string
  onToolInlineAction?: (action: ToolInlineAction) => void
}) {
  const groups = useMemo(() => groupConsecutiveBlocks(blocks), [blocks])

  return (
    <div className="space-y-2 [&>*:first-child]:mt-0 [&>*:first-child>*:first-child]:mt-0 [&>*:last-child]:mb-0 [&>*:last-child>*:last-child]:mb-0">
      {groups.map((group, i) => {
        if (group.type === 'single') {
          const block = group.block
          if (block.type === 'thinking') {
            return (
              <ThinkingSection
                key={block.id}
                thinking={block.content}
                durationMs={block.durationMs}
                showRaw={showRaw}
              />
            )
          }
          if (block.type === 'tool_use') {
            return (
              <SingleToolCallSection key={block.id} toolCall={block.toolCall} onToolInlineAction={onToolInlineAction} />
            )
          }
          if (block.type === 'text') {
            return <ParsedTextContent key={block.id} content={block.content} showRaw={showRaw} agentId={agentId} />
          }
          return null
        } else {
          // Multi-block group
          return (
            <BlockGroupSection
              key={`group-${i}`}
              blocks={group.blocks}
              showRaw={showRaw}
              onToolInlineAction={onToolInlineAction}
            />
          )
        }
      })}
    </div>
  )
}

/**
 * Single tool call display (used in ordered blocks rendering and streaming)
 */
export function SingleToolCallSection({
  toolCall,
  onToolInlineAction,
}: {
  toolCall: MessageToolCall
  onToolInlineAction?: (action: ToolInlineAction) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const toolRenderers = useToolRenderers()
  const isIncomplete = !toolCall.result && !toolCall.isError
  const isError = toolCall.isError || isIncomplete
  const result = toolCall.result || (isIncomplete ? 'Command aborted' : '')

  return (
    <div className="text-xs">
      <button
        data-tool-call-row={toolCall.toolCallId}
        onClick={() => setExpanded(!expanded)}
        className="ficus-button w-full flex items-center gap-1.5 py-0.5 text-secondary hover:text-primary transition-colors text-left min-w-0"
      >
        {isError ? (
          <span className="text-status-danger-500 dark:text-status-danger-400 shrink-0 inline-block w-3 text-center">
            &#10007;
          </span>
        ) : (
          <span className="text-status-success-600 dark:text-status-success-400 shrink-0 inline-block w-3 text-center">
            &#10003;
          </span>
        )}
        <span className="font-medium shrink-0">{toolCall.toolName}</span>
        <ToolSummary renderers={toolRenderers} toolName={toolCall.toolName} args={toolCall.args} />
        {isError && (
          <span className="text-status-danger-500 dark:text-status-danger-400 text-[10px] font-medium shrink-0">
            ERROR
          </span>
        )}
        <ChevronRightIcon
          className={clsx('w-3 h-3 shrink-0 text-muted transition-transform', expanded && 'rotate-90')}
        />
      </button>
      <ToolInlineActions
        toolCall={toolCall}
        completed={Boolean(toolCall.result) || toolCall.isError}
        onOpen={onToolInlineAction}
      />
      {expanded && (
        <div className="mt-1 ml-1.5 border-l-2 border-th-border pl-3 py-0.5 space-y-1">
          {toolCall.args && (
            <ToolArgsView renderers={toolRenderers} toolName={toolCall.toolName} args={toolCall.args} />
          )}
          {result && (
            <ToolResultView renderers={toolRenderers} toolName={toolCall.toolName} result={result} isError={isError} />
          )}
        </div>
      )}
    </div>
  )
}

export function ThinkingSection({
  thinking,
  isStreaming,
  durationMs,
  showRaw,
}: {
  thinking: string
  isStreaming?: boolean
  durationMs?: number
  showRaw?: boolean
}) {
  // Expanded while actively streaming thinking, collapsed otherwise
  const [collapsed, setCollapsed] = useState(!isStreaming)
  const wasStreaming = useRef(isStreaming)
  const [elapsed, setElapsed] = useState(0)
  const startRef = useRef<number | null>(null)

  // Live elapsed timer while streaming
  useEffect(() => {
    if (isStreaming) {
      if (!startRef.current) startRef.current = Date.now()
      const interval = setInterval(() => {
        setElapsed(Date.now() - startRef.current!)
      }, 100)
      return () => clearInterval(interval)
    }
    startRef.current = null
  }, [isStreaming])

  useEffect(() => {
    if (wasStreaming.current && !isStreaming) {
      setCollapsed(true)
    }
    wasStreaming.current = isStreaming
  }, [isStreaming])

  // Labels match the mobile ThinkingSection exactly.
  const secs = durationMs === undefined ? null : (durationMs / 1000).toFixed(1)
  const label = isStreaming
    ? `Thinking for ${Math.floor(elapsed / 1000)}s…`
    : secs && secs !== '0.0'
      ? `Thought for ${secs}s`
      : 'Thought for a moment'

  return (
    <div className="text-xs">
      <button
        onClick={() => setCollapsed(!collapsed)}
        className="ficus-button w-full flex items-center gap-1.5 py-0.5 text-status-human-wait-600 dark:text-status-human-wait-400 hover:text-status-human-wait-800 dark:hover:text-status-human-wait-300 transition-colors"
      >
        {isStreaming ? (
          <span className="inline-block w-3 h-3 border-2 border-status-human-wait-300 dark:border-status-human-wait-700 border-t-status-human-wait-600 dark:border-t-status-human-wait-300 rounded-full animate-spin shrink-0" />
        ) : (
          <span className="shrink-0 inline-block w-3 text-center">✦</span>
        )}
        <span className="font-medium">{label}</span>
        <ChevronRightIcon
          className={clsx(
            'w-3 h-3 shrink-0 text-status-human-wait-400 dark:text-status-human-wait-500 transition-transform',
            !collapsed && 'rotate-90'
          )}
        />
      </button>
      {!collapsed && (
        <div className="mt-1 ml-1.5 border-l-2 border-status-human-wait-200 dark:border-status-human-wait-900/60 pl-3 py-0.5 text-secondary max-h-60 overflow-y-auto">
          {showRaw ? (
            <pre className="whitespace-pre-wrap font-mono text-sm">{thinking}</pre>
          ) : (
            <MarkdownContent>{thinking}</MarkdownContent>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * Renders a group of consecutive tool/thinking blocks as a single collapsible section.
 * Used when multiple non-text blocks appear in sequence.
 */
function BlockGroupSection({
  blocks,
  defaultExpanded = false,
  showRaw,
  onToolInlineAction,
}: {
  blocks: ContentBlock[]
  defaultExpanded?: boolean
  showRaw?: boolean
  onToolInlineAction?: (action: ToolInlineAction) => void
}) {
  const [expanded, setExpanded] = useState(defaultExpanded)
  const summary = getGroupSummary(blocks)

  return (
    <div className="text-xs">
      <button
        onClick={() => setExpanded(!expanded)}
        className="ficus-button w-full flex items-center gap-1.5 py-0.5 text-secondary hover:text-primary transition-colors"
      >
        <ChevronRightIcon
          className={clsx('w-3 h-3 shrink-0 text-muted transition-transform', expanded && 'rotate-90')}
        />
        <span className="font-medium">{summary}</span>
      </button>
      {expanded && (
        <div className="mt-1 ml-1.5 border-l-2 border-th-border pl-3 py-0.5 space-y-2">
          {blocks.map((block) => {
            if (block.type === 'thinking') {
              return (
                <ThinkingSection
                  key={block.id}
                  thinking={block.content}
                  durationMs={block.durationMs}
                  showRaw={showRaw}
                />
              )
            }
            if (block.type === 'tool_use') {
              return (
                <SingleToolCallSection
                  key={block.id}
                  toolCall={block.toolCall}
                  onToolInlineAction={onToolInlineAction}
                />
              )
            }
            return null
          })}
        </div>
      )}
    </div>
  )
}

function StepCompleteBlock({ message }: { message?: string }) {
  return (
    <div className="border border-status-success-200 dark:border-status-success-800 rounded-md bg-status-success-50/50 dark:bg-status-success-900/20 text-xs">
      <div className="flex items-center gap-1.5 px-2.5 py-1.5 text-status-success-700 dark:text-status-success-300 font-medium">
        <span>&#10003;</span>
        <span>Step complete</span>
      </div>
      {message && (
        <div className="border-t border-status-success-200 dark:border-status-success-800 px-2.5 py-2 text-secondary">
          {message}
        </div>
      )}
    </div>
  )
}

function RewindBlock({ step, message, showRaw }: { step: string; message: string; showRaw?: boolean }) {
  return (
    <div className="border border-status-external-wait-200 dark:border-status-external-wait-800 rounded-md bg-status-external-wait-50/50 dark:bg-status-external-wait-900/20 text-xs">
      <div className="flex items-center gap-1.5 px-2.5 py-1.5 text-status-external-wait-700 dark:text-status-external-wait-300 font-medium">
        <span>&#8634;</span>
        <span>Rewind to {step}</span>
      </div>
      <div className="border-t border-status-external-wait-200 dark:border-status-external-wait-800 px-2.5 py-2 text-secondary text-xs [&_.prose]:text-xs">
        {showRaw ? (
          <pre className="whitespace-pre-wrap font-mono text-sm">{message}</pre>
        ) : (
          <MarkdownContent>{message}</MarkdownContent>
        )}
      </div>
    </div>
  )
}
