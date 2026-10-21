import { useState } from 'react'
import clsx from 'clsx'
import type { ExecutionStatus } from '@ficus/shared'
import { ActionPopup } from './ThemedPopup'
import { Modal } from './Modal'
import { formatContextPercent, formatTokens } from '../lib/format'

/** A turn's state worth saying in words; plain "running" is already the Stop button and the working row. */
const STATUS_LABEL: Partial<Record<ExecutionStatus | 'compacting' | 'resetting', string>> = {
  queued: 'Queued',
  'waiting-sandbox': 'Waiting for sandbox',
  stopping: 'Stopping…',
  compacting: 'Compacting…',
  resetting: 'Resetting…',
}

const CONFIRM = {
  compact: {
    title: 'Compact this session?',
    action: 'Compact context',
    body: 'The session history is summarized to free up context; the agent keeps the summary, not every message.',
  },
  reset: {
    title: 'Reset this session?',
    action: 'Reset session',
    body: 'The agent’s session history is cleared and it starts fresh, without what was said here in its context.',
  },
} as const

/** How full the context is, as a ring: the theme's primary color, then amber past half, red past 80%. */
export function ContextRing({ percent, className }: { percent: number; className?: string }) {
  const clamped = Math.max(0, Math.min(percent, 100))
  const radius = 6
  const circumference = 2 * Math.PI * radius
  return (
    <svg
      viewBox="0 0 16 16"
      aria-hidden="true"
      className={clsx(
        'h-4 w-4 shrink-0 -rotate-90',
        clamped > 80 ? 'text-status-danger-400' : clamped > 50 ? 'text-status-review-400' : 'text-accent',
        className
      )}
    >
      <circle cx="8" cy="8" r={radius} fill="none" stroke="currentColor" strokeWidth="2.5" opacity="0.25" />
      <circle
        cx="8"
        cy="8"
        r={radius}
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={circumference * (1 - clamped / 100)}
      />
    </svg>
  )
}

/**
 * What the agent is up to, small, beside the chat composer's controls: a word
 * for the in-between states (queued, waiting for a sandbox, compacting…),
 * and a ring showing how much context is used. The ring opens the
 * numbers and the session actions (Compact, Reset); cost and the rest live in
 * the Info tab.
 */
export function AgentComposerStatus({
  status,
  context,
  canManageSession,
  onCompact,
  onReset,
}: {
  /** The execution's (or the agent's compacting/resetting) state, if any. */
  status?: ExecutionStatus | 'compacting' | 'resetting'
  /** The session's current context: what the next request carries, not the session's cumulative usage. */
  context?: { percent: number; tokens: number; contextWindow: number }
  /** Idle and allowed: Compact and Reset are only offered then. */
  canManageSession: boolean
  onCompact: () => void
  onReset: () => void
}) {
  // Both session actions confirm first: the menu opens under a passing mouse, so one stray click must not run either.
  const [confirming, setConfirming] = useState<'compact' | 'reset' | null>(null)
  const confirm = confirming ? CONFIRM[confirming] : null
  const label = status ? STATUS_LABEL[status] : undefined
  // The label beside the ring stays compact (whole percents); the tooltip and the
  // popup's heading carry the precise figure and the tokens behind it.
  const percent = context ? `${Math.round(context.percent)}%` : ''
  const summary = context
    ? `Context ${formatContextPercent(context.percent)} used · ${formatTokens(context.tokens)} of ${formatTokens(context.contextWindow)} tokens`
    : ''

  return (
    <div className="flex min-w-0 items-center gap-1.5">
      {label && (
        <span role="status" className="truncate text-xs text-muted">
          {label}
        </span>
      )}
      {context && (
        <ActionPopup
          label={`Context ${percent} used`}
          openOnHover
          title={summary}
          heading={summary}
          width={260}
          className="ficus-button ficus-button-ghost flex min-h-[44px] items-center gap-1 rounded-md px-2 text-xs tabular-nums md:min-h-0 md:py-1.5"
          items={[
            {
              id: 'compact',
              label: 'Compact context',
              description: canManageSession
                ? 'Summarize the session to free up context'
                : 'Available when the agent is idle',
              disabled: !canManageSession,
              opensDialog: true,
              onSelect: () => setConfirming('compact'),
            },
            {
              id: 'reset',
              label: 'Reset session',
              description: canManageSession
                ? 'Clear the session history and start fresh'
                : 'Available when the agent is idle',
              disabled: !canManageSession,
              opensDialog: true,
              onSelect: () => setConfirming('reset'),
            },
          ]}
        >
          <ContextRing percent={context.percent} />
          <span>{percent}</span>
        </ActionPopup>
      )}
      <Modal
        isOpen={confirm !== null}
        onClose={() => setConfirming(null)}
        title={confirm?.title ?? ''}
        footer={
          <div className="flex justify-end gap-2">
            <button
              type="button"
              className="ficus-button ficus-button-secondary rounded-md px-3 py-1.5 text-sm"
              onClick={() => setConfirming(null)}
            >
              Cancel
            </button>
            <button
              type="button"
              className={clsx(
                'ficus-button rounded-md px-3 py-1.5 text-sm font-medium',
                confirming === 'reset' ? 'ficus-button-danger' : 'ficus-button-primary'
              )}
              onClick={() => {
                setConfirming(null)
                if (confirming === 'reset') onReset()
                else onCompact()
              }}
            >
              {confirm?.action}
            </button>
          </div>
        }
      >
        <p className="text-sm text-secondary">{confirm?.body}</p>
      </Modal>
    </div>
  )
}
