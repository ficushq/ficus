import clsx from 'clsx'
import { useState, type ReactNode } from 'react'
import { MarkdownContent } from '../components/MarkdownContent'
import { ChevronRightIcon, SpinnerIcon, StopIcon } from '../components/icons'
import {
  genericToolRenderers,
  type ToolRenderers,
  ToolArgsView,
  ToolResultView,
  ToolSummary,
} from '../lib/tool-renderers'
import { summarizeAssistantError } from './assistantErrorPresentation'
import type { VoiceTranscriptEntry } from './types'

export function VoiceTranscriptInspector({
  history,
  renderEntryFooter,
  emptyLabel = 'Start speaking...',
  className,
  defaultToolExpanded = false,
  alignContent = false,
  onInterrupt,
  activityLabel,
  toolRenderers = genericToolRenderers,
}: {
  renderEntryFooter?: (entry: VoiceTranscriptEntry) => ReactNode
  history: VoiceTranscriptEntry[]
  activityLabel?: string
  toolRenderers?: ToolRenderers
  emptyLabel?: ReactNode
  className?: string
  alignContent?: boolean
  defaultToolExpanded?: boolean
  onInterrupt?: () => void
}) {
  if (history.length === 0 && !onInterrupt && !activityLabel) {
    return <div className="px-3 py-6 text-center text-sm text-muted">{emptyLabel}</div>
  }

  const last = history.at(-1)
  const streamingText = last?.role === 'assistant' && !last.final && Boolean(last.text)
  return (
    <div
      className={clsx('flex min-w-0 flex-col gap-1 [overflow-wrap:anywhere]', alignContent ? 'p-3' : 'p-2', className)}
    >
      {history.map((entry, i) => {
        if (activityLabel && entry.role === 'assistant' && !entry.final && !entry.text) return null
        const prev = i > 0 ? history[i - 1] : null
        const roleChanged = prev && prev.role !== entry.role && prev.role !== 'tool' && entry.role !== 'tool'
        const key = entry.id ?? entry.toolCallId ?? `${entry.role}-${i}`
        return (
          <div key={key} className={clsx('min-w-0', roleChanged && 'mt-1.5')}>
            <TranscriptBubble
              alignContent={alignContent}
              entry={entry}
              toolRenderers={toolRenderers}
              defaultToolExpanded={defaultToolExpanded}
              onInterrupt={
                i === history.length - 1 && entry.role === 'assistant' && (!activityLabel || streamingText)
                  ? onInterrupt
                  : undefined
              }
            />
            {renderEntryFooter?.(entry)}
          </div>
        )
      })}
      {!activityLabel && onInterrupt && history.at(-1)?.role !== 'assistant' && (
        <TranscriptBubble
          entry={{ role: 'assistant', text: 'Thinking…', final: false }}
          defaultToolExpanded={false}
          onInterrupt={onInterrupt}
        />
      )}
      {activityLabel && (
        <div className="flex items-center gap-2 px-2.5 py-2 text-sm text-muted">
          <div role="status" aria-live="polite" className="flex items-center gap-2">
            <span aria-hidden="true">
              <SpinnerIcon className="h-4 w-4 text-accent-light motion-safe:animate-spin" />
            </span>
            {activityLabel}
          </div>
          {onInterrupt && !streamingText && (
            <button
              type="button"
              onClick={onInterrupt}
              aria-label="Stop response"
              title="Stop response"
              className="ficus-button ml-auto flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-surface-hover hover:text-primary"
            >
              <StopIcon className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      )}
    </div>
  )
}

function TranscriptBubble({
  alignContent = false,
  entry,
  defaultToolExpanded,
  onInterrupt,
  toolRenderers,
}: {
  alignContent?: boolean
  toolRenderers?: ToolRenderers
  entry: VoiceTranscriptEntry
  defaultToolExpanded: boolean
  onInterrupt?: () => void
}) {
  if (entry.role === 'tool')
    return (
      <ToolTranscriptEntry
        entry={entry}
        defaultExpanded={defaultToolExpanded}
        toolRenderers={toolRenderers ?? genericToolRenderers}
      />
    )

  const isUser = entry.role === 'user'
  return (
    <div className={clsx('flex min-w-0', isUser ? 'justify-end' : 'justify-start', onInterrupt && 'w-full gap-2')}>
      <div
        className={clsx(
          'min-w-0 rounded-lg py-1.5 text-sm',
          alignContent && !isUser ? 'w-full px-0' : 'max-w-[85%] px-2.5',
          {
            'bg-selection text-primary': isUser && entry.final,
            'bg-selection text-muted italic': isUser && !entry.final,
            'text-primary': !isUser && entry.final,
            'text-muted italic': !isUser && !entry.final,
          }
        )}
      >
        {!isUser && entry.text ? (
          <MarkdownContent className="[&>:first-child]:mt-0 [&>:last-child]:mb-0">{entry.text}</MarkdownContent>
        ) : (
          entry.text || '...'
        )}
        {entry.interrupted && <span className="ml-1 text-xs text-muted italic">(stopped)</span>}
      </div>
      {onInterrupt && (
        <button
          type="button"
          onClick={onInterrupt}
          aria-label="Stop response"
          title="Stop response"
          className="ficus-button ml-auto mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-surface-hover hover:text-primary"
        >
          <StopIcon className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  )
}

function ToolTranscriptEntry({
  entry,
  defaultExpanded,
  toolRenderers,
}: {
  entry: VoiceTranscriptEntry
  defaultExpanded: boolean
  toolRenderers: ToolRenderers
}) {
  const [expanded, setExpanded] = useState(defaultExpanded)
  const toolName = entry.toolName ?? 'tool'
  const hasDetails = Boolean(entry.toolArgs || entry.toolResult)
  const result = parseJson(entry.toolResult)
  const error = typeof result?.error === 'string' ? result.error : undefined
  const failed = entry.toolError || Boolean(error) || result?.isError === true

  return (
    <div className="flex justify-start">
      <div className="max-w-full min-w-0 rounded-lg text-xs text-muted">
        <button
          type="button"
          onClick={() => hasDetails && setExpanded((value) => !value)}
          className="ficus-button flex w-full min-w-0 items-center gap-1.5 rounded-lg px-2 py-1.5 text-left hover:bg-surface-hover disabled:hover:bg-transparent"
          disabled={!hasDetails}
          aria-expanded={hasDetails ? expanded : undefined}
        >
          {entry.final ? (
            failed ? (
              <span
                className="shrink-0 text-status-danger-500 dark:text-status-danger-400"
                role="img"
                aria-label="Tool failed"
              >
                &#10007;
              </span>
            ) : (
              <span className="shrink-0 text-muted">&#10003;</span>
            )
          ) : (
            <span className="inline-block h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-status-neutral-300 border-t-status-neutral-600 dark:border-status-neutral-600 dark:border-t-status-neutral-300" />
          )}
          {!(toolRenderers[toolName] && (entry.toolArgs || entry.text)) && (
            <span className="min-w-0 truncate font-medium text-secondary">{toolName}</span>
          )}
          {entry.toolArgs ? (
            <ToolSummary renderers={toolRenderers} toolName={toolName} args={entry.toolArgs} />
          ) : entry.text ? (
            <span className="truncate text-muted">{entry.text}</span>
          ) : null}
          {hasDetails && (
            <ChevronRightIcon
              className={clsx('ml-auto h-3 w-3 shrink-0 transition-transform', expanded && 'rotate-90')}
            />
          )}
        </button>
        {failed && (
          <p className="px-2 py-1 text-xs text-danger break-words">
            {summarizeAssistantError(error ?? 'Tool failed. Expand for details.')}
          </p>
        )}
        {expanded && (
          <div className="space-y-2 mt-1 rounded-lg bg-surface-secondary px-2 py-2 overflow-x-auto">
            {entry.toolArgs && (
              <div className="space-y-1">
                <div className="text-xs font-medium text-muted">Arguments</div>
                <ToolArgsView renderers={toolRenderers} toolName={toolName} args={entry.toolArgs} />
              </div>
            )}
            {entry.toolResult && (
              <div className="space-y-1">
                <div className="text-xs font-medium text-muted">Result</div>
                <ToolResultView
                  renderers={toolRenderers}
                  toolName={toolName}
                  result={entry.toolResult}
                  isError={failed}
                />
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function parseJson(value?: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(value ?? '')
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}
