import { useState } from 'react'
import clsx from 'clsx'
import type { ExecutionStatus } from '@ficus/shared'
import { ActionPopup } from './ThemedPopup'
import { Modal } from './Modal'
import { AgentSlotWaitStatus } from './AgentSlotWaitStatus'
import { formatTokens } from '../lib/format'

/** A turn's state worth saying in words; plain "running" is already the Stop button and the working row. */
const STATUS_LABEL: Partial<Record<ExecutionStatus | 'compacting' | 'resetting', string>> = {
  queued: 'Queued',
  'waiting-sandbox': 'Waiting for sandbox',
  stopping: 'Stopping…',
  compacting: 'Compacting…',
  resetting: 'Resetting…',
}

/** How full the context is, as a ring: blue, then amber past half, red past 80%. */
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
        clamped > 80 ? 'text-status-danger-400' : clamped > 50 ? 'text-status-review-400' : 'text-status-progress-400',
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
 * slot waits, and a ring showing how much context is used. The ring opens the
 * numbers and the session actions (Compact, Reset); cost and the rest live in
 * the Info tab.
 */
export function AgentComposerStatus({
  agentId,
  squadId,
  status,
  context,
  canManageSession,
  onCompact,
  onReset,
}: {
  agentId: string
  squadId?: string | null
  /** The execution's (or the agent's compacting/resetting) state, if any. */
  status?: ExecutionStatus | 'compacting' | 'resetting'
  context?: { percent: number; tokens: number }
  /** Idle and allowed: Compact and Reset are only offered then. */
  canManageSession: boolean
  onCompact: () => void
  onReset: () => void
}) {
  const [confirmReset, setConfirmReset] = useState(false)
  const label = status ? STATUS_LABEL[status] : undefined
  const percent = context ? Math.round(context.percent) : 0

  return (
    <div className="flex min-w-0 items-center gap-1.5">
      {label && (
        <span role="status" className="truncate text-xs text-muted">
          {label}
        </span>
      )}
      {squadId && <AgentSlotWaitStatus agentId={agentId} squadId={squadId} />}
      {context && (
        <ActionPopup
          label={`Context ${percent}% used`}
          title={`Context ${percent}% used · ${formatTokens(context.tokens)} tokens`}
          heading={`Context ${percent}% used · ${formatTokens(context.tokens)} tokens`}
          width={260}
          className="ficus-button flex min-h-[44px] items-center gap-1 rounded-md px-2 text-xs tabular-nums text-muted hover:bg-surface-hover hover:text-primary md:min-h-0 md:py-1.5"
          items={[
            {
              id: 'compact',
              label: 'Compact context',
              description: canManageSession
                ? 'Summarize the session to free up context'
                : 'Available when the agent is idle',
              disabled: !canManageSession,
              onSelect: onCompact,
            },
            {
              id: 'reset',
              label: 'Reset session',
              description: canManageSession
                ? 'Clear the session history and start fresh'
                : 'Available when the agent is idle',
              disabled: !canManageSession,
              opensDialog: true,
              onSelect: () => setConfirmReset(true),
            },
          ]}
        >
          <ContextRing percent={context.percent} />
          <span>{percent}%</span>
        </ActionPopup>
      )}
      <Modal
        isOpen={confirmReset}
        onClose={() => setConfirmReset(false)}
        title="Reset this session?"
        footer={
          <div className="flex justify-end gap-2">
            <button
              type="button"
              className="ficus-button ficus-button-secondary rounded-md px-3 py-1.5 text-sm"
              onClick={() => setConfirmReset(false)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="ficus-button rounded-md bg-status-danger-600 px-3 py-1.5 text-sm font-medium text-on-strong hover:bg-status-danger-700"
              onClick={() => {
                setConfirmReset(false)
                onReset()
              }}
            >
              Reset session
            </button>
          </div>
        }
      >
        <p className="text-sm text-secondary">
          The agent&rsquo;s session history is cleared and it starts fresh, without what was said here in its context.
        </p>
      </Modal>
    </div>
  )
}
