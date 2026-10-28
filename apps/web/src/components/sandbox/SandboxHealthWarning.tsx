import { hasSandboxPressureWarning } from '@ficus/shared'
import { useId, useRef } from 'react'
import { Link } from 'react-router-dom'
import type { SandboxStatus } from '../../api/workspace'
import { WarningIcon } from '../icons'
import { HoverCard, useHoverCard } from '../popover'
import { PressureSummary } from './SandboxProcesses'
import { sandboxReasonDetail } from './sandboxStatusStyles'
import { resolveVmChainDisplay } from './vmChainHealth'

// Exact normal-startup reasons emitted by VM getSandboxStatus, including older
// payloads without runtimeHealth. These are context, not evidence of a failure.
const VM_STARTUP_REASONS = new Set([
  'sandbox setup has not been reconciled',
  'required sandbox assets are not ready',
  'box is provisioning or its health probe has not yet passed',
])

/** Diagnostic context for the header pill, without fetching the expensive Processes listing. */
export function SandboxHealthWarning({ squadId, status }: { squadId: string; status: SandboxStatus }) {
  const anchor = useRef<HTMLButtonElement>(null)
  const id = useId()
  const hover = useHoverCard({ focusVisibleOnly: false })
  const overloaded = hasSandboxPressureWarning(status.pressure)
  const degraded = status.runtimeHealth?.status === 'degraded' || status.readiness === 'ready_degraded'
  const runtimeReason = sandboxReasonDetail(status.runtimeHealth?.reason)
  const statusReason = sandboxReasonDetail(status.reason)
  const normalStartup = status.status === 'starting' && VM_STARTUP_REASONS.has(status.reason ?? '')
  const hasWarningReason = runtimeReason || (statusReason && !normalStartup)
  if (!overloaded && !degraded && !hasWarningReason) return null

  // Eligibility is separate from context: even normal startup reasons remain
  // available when pressure or explicit degradation actually warrants a warning.
  const reasons = [
    ...new Set(
      [runtimeReason, statusReason, degraded ? resolveVmChainDisplay(status).detail : undefined].filter(
        (reason): reason is string => !!reason
      )
    ),
  ]
  const details = (
    <>
      {overloaded && status.pressure && <PressureSummary pressure={status.pressure} />}
      {reasons.map((reason) => (
        <p key={reason}>{reason}</p>
      ))}
      {degraded && reasons.length === 0 && <p>Sandbox is degraded. Inspect Processes for details.</p>}
    </>
  )
  return (
    <>
      <button
        ref={anchor}
        {...hover.anchorHandlers}
        type="button"
        aria-label="Sandbox warning"
        aria-describedby={`${id}-description`}
        aria-haspopup="dialog"
        aria-expanded={hover.open}
        aria-controls={hover.open ? id : undefined}
        onClick={(event) => {
          event.stopPropagation()
          hover.show()
        }}
        className="ficus-button ficus-button-link rounded text-status-review-700 dark:text-status-review-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        <WarningIcon className="h-4 w-4" />
      </button>
      <div id={`${id}-description`} className="sr-only">
        {details}
      </div>
      <HoverCard
        id={id}
        hover={hover}
        anchor={anchor}
        label="Sandbox warning details"
        className="ficus-overlay w-80 space-y-2 p-3 text-sm text-primary"
      >
        {details}
        <Link
          to={`/squads/${encodeURIComponent(squadId)}/settings?section=workspace&setting=sandbox-processes`}
          onClick={hover.hide}
          className="ficus-button ficus-button-link inline-block rounded underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          Open Processes
        </Link>
      </HoverCard>
    </>
  )
}
