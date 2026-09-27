import { useEffect, useId, useMemo, useRef, useState } from 'react'
import clsx from 'clsx'
import type { MessageToolCall } from '@ficus/shared'
import { groupBlocks, groupSummary, prettyArgs, resultText, thinkingLabel, toolSummary, type AnyBlock } from './blocks'
import { Markdown } from './Markdown'

function Disclosure({
  expanded,
  onToggle,
  controls,
  className,
  children,
}: {
  expanded: boolean
  onToggle: () => void
  controls: string
  className?: string
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      className={clsx('g-chat-row-toggle', className)}
      aria-expanded={expanded}
      aria-controls={controls}
      onClick={onToggle}
    >
      <span className={clsx('g-chat-chevron', expanded && 'g-open')} aria-hidden="true">
        ▸
      </span>
      {children}
    </button>
  )
}

export function ToolCallRow({ toolCall, running = false }: { toolCall: MessageToolCall; running?: boolean }) {
  const [expanded, setExpanded] = useState(false)
  const id = useId()
  // Like the web: a settled call with neither result nor error was cut off.
  const incomplete = !running && !toolCall.result && !toolCall.isError
  const failed = toolCall.isError || incomplete
  const result = toolCall.result || (incomplete ? 'Command aborted' : '')
  const summary = toolSummary(toolCall.toolName, toolCall.args)

  return (
    <div className="g-chat-tool" data-tool-call={toolCall.toolCallId}>
      <Disclosure expanded={expanded} onToggle={() => setExpanded((v) => !v)} controls={id}>
        <span
          className={clsx('g-chat-tool-mark', running ? 'g-running' : failed ? 'g-failed' : 'g-ok')}
          aria-hidden="true"
        >
          {running ? '' : failed ? '✗' : '✓'}
        </span>
        <span className="g-chat-tool-name">{toolCall.toolName}</span>
        {summary && (
          <span className="g-chat-tool-summary" title={summary}>
            {summary}
          </span>
        )}
        {running && <span className="g-chat-sr-only">running</span>}
        {failed && <span className="g-chat-tool-error">ERROR</span>}
      </Disclosure>
      {expanded && (
        <div id={id} className="g-chat-row-body">
          {toolCall.args && <pre className="g-chat-code">{prettyArgs(toolCall.args)}</pre>}
          {result && <pre className={clsx('g-chat-code', failed && 'g-failed')}>{resultText(result)}</pre>}
        </div>
      )}
    </div>
  )
}

export function ThinkingRow({
  content,
  durationMs,
  streaming = false,
}: {
  content: string
  durationMs?: number
  streaming?: boolean
}) {
  const [expanded, setExpanded] = useState(streaming)
  const [seconds, setSeconds] = useState(0)
  const startedAt = useRef<number | null>(null)
  const wasStreaming = useRef(streaming)
  const id = useId()

  useEffect(() => {
    if (!streaming) {
      startedAt.current = null
      return
    }
    startedAt.current ??= Date.now()
    const timer = setInterval(() => setSeconds(Math.floor((Date.now() - startedAt.current!) / 1000)), 1000)
    return () => clearInterval(timer)
  }, [streaming])

  useEffect(() => {
    // Collapse once the model stops thinking, like the web.
    if (wasStreaming.current && !streaming) setExpanded(false)
    wasStreaming.current = streaming
  }, [streaming])

  return (
    <div className="g-chat-thinking">
      <Disclosure expanded={expanded} onToggle={() => setExpanded((v) => !v)} controls={id}>
        <span className="g-chat-tool-mark g-thought" aria-hidden="true">
          ✦
        </span>
        <span>{thinkingLabel(durationMs, streaming ? seconds : undefined)}</span>
      </Disclosure>
      {expanded && (
        <div id={id} className="g-chat-row-body g-chat-thinking-body">
          <Markdown>{content}</Markdown>
        </div>
      )}
    </div>
  )
}

function isRunning(block: AnyBlock, streaming: boolean): boolean {
  return streaming && block.type === 'tool_use' && '_done' in block && block._done === false
}

function BlockGroupRow({ blocks, streaming }: { blocks: AnyBlock[]; streaming: boolean }) {
  const [expanded, setExpanded] = useState(false)
  const id = useId()
  const running = blocks.some((b) => isRunning(b, streaming))
  return (
    <div className="g-chat-group">
      <Disclosure expanded={expanded} onToggle={() => setExpanded((v) => !v)} controls={id}>
        {running && <span className="g-chat-tool-mark g-running" aria-hidden="true" />}
        <span className="g-chat-tool-name">{groupSummary(blocks)}</span>
      </Disclosure>
      {expanded && (
        <div id={id} className="g-chat-row-body">
          {blocks.map((block) =>
            block.type === 'thinking' ? (
              <ThinkingRow key={block.id} content={block.content} durationMs={block.durationMs} />
            ) : block.type === 'tool_use' ? (
              <ToolCallRow key={block.id} toolCall={block.toolCall} running={isRunning(block, streaming)} />
            ) : null
          )}
        </div>
      )}
    </div>
  )
}

/**
 * An assistant turn's ordered blocks. While `streaming`, the tail text shows a
 * caret and the tail thinking block its live timer.
 */
export function MessageBlocks({ blocks, streaming = false }: { blocks: AnyBlock[]; streaming?: boolean }) {
  const groups = useMemo(() => groupBlocks(blocks), [blocks])
  const last = blocks.length - 1
  return (
    <div className="g-chat-blocks">
      {groups.map((group) => {
        if (group.type === 'group') {
          return <BlockGroupRow key={`group-${group.startIndex}`} blocks={group.blocks} streaming={streaming} />
        }
        const { block, index } = group
        const tail = streaming && index === last
        if (block.type === 'text') {
          return (
            <div key={block.id} className={clsx('g-chat-text', tail && 'g-streaming')}>
              <Markdown>{block.content}</Markdown>
            </div>
          )
        }
        if (block.type === 'thinking') {
          return <ThinkingRow key={block.id} content={block.content} durationMs={block.durationMs} streaming={tail} />
        }
        return <ToolCallRow key={block.id} toolCall={block.toolCall} running={isRunning(block, streaming)} />
      })}
    </div>
  )
}
