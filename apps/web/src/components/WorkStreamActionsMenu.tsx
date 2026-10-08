import { useHref } from 'react-router-dom'
import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { readDeliveryState, type WorkStream } from '@ficus/shared'
import { client } from '../api/clientInstance'
import { usePermissions } from '../hooks/usePermissions'
import { useWorkflowRefresh } from '../hooks/useWorkflowRefresh'
import { actionErrorMessage } from '../lib/actionError'
import { getWorkStreamLink } from '../lib/inboxWorkStreamLink'
import { PULL_REQUEST_COMPLETION_MODES } from '../lib/workflowReview'
import { workStreamPullRequests } from '../lib/workStreamGithub'
import { queries } from '../queryOptions'
import { AttentionMenu } from './AttentionMenu'
import { Panel, usePopover } from './popover'
import type { useWorkStreamPauseControls } from './WorkStreamPauseControls'

/** A disclosure of secondary actions; native buttons remain reachable with Tab. */
export function WorkStreamActionsMenu({
  stream,
  controls,
}: {
  stream: WorkStream
  controls: ReturnType<typeof useWorkStreamPauseControls>
}) {
  const href = useHref(
    getWorkStreamLink({ squadId: stream.squadId, workStreamId: stream.id, workStreamNumber: stream.number })!
  )
  const popover = usePopover({ kind: 'disclosure' })
  const { close, triggerRef: trigger } = popover
  const [feedback, setFeedback] = useState('')
  const wasEditing = useRef(false)
  useEffect(() => {
    if (wasEditing.current && !controls.editing) trigger.current?.focus()
    wasEditing.current = controls.editing
  }, [controls.editing, trigger])
  const itemClass = 'ficus-button ficus-button-ghost w-full rounded-md px-3 py-2 text-left text-sm'
  const deliveryCheck = useManualDeliveryCheck(stream, setFeedback)
  const copyLink = async () => {
    close({ returnFocus: true })
    try {
      await navigator.clipboard.writeText(new URL(href, window.location.origin).href)
      setFeedback('Link copied')
    } catch {
      setFeedback('Could not copy link. Try again.')
    }
  }
  return (
    <div className="relative">
      <button
        {...popover.triggerProps}
        type="button"
        aria-label="More actions"
        className="ficus-button ficus-button-ghost rounded-md px-3 py-1"
        onClick={() => {
          popover.toggle()
          setFeedback('')
        }}
      >
        ⋯
      </button>
      <Panel
        {...popover.popoverProps}
        role="group"
        label="More actions"
        initialFocus="none"
        gap={4}
        className="ficus-overlay w-72 rounded-lg border border-th-border bg-surface p-1 shadow-theme-lg"
      >
        {controls.canPause && (
          <button
            type="button"
            className={itemClass}
            disabled={controls.action.isPending}
            onClick={() => {
              close()
              controls.openPause()
            }}
          >
            Pause work…
          </button>
        )}
        {controls.canPark && (
          <button
            type="button"
            className={itemClass}
            disabled={controls.action.isPending}
            onClick={() => {
              close({ returnFocus: true })
              controls.park()
            }}
          >
            Park while paused
          </button>
        )}
        {deliveryCheck && (
          <button
            type="button"
            className={itemClass}
            disabled={deliveryCheck.isPending}
            onClick={() => {
              close({ returnFocus: true })
              deliveryCheck.run()
            }}
          >
            Check delivery now
          </button>
        )}
        <AttentionMenu target={{ kind: 'workStream', id: stream.id }} inline />
        <button type="button" className={itemClass} onClick={copyLink}>
          Copy link
        </button>
      </Panel>
      {feedback && (
        <span
          role="status"
          className="absolute right-0 top-full z-30 mt-1 whitespace-nowrap rounded border border-th-border bg-surface p-2 text-xs"
        >
          {feedback}
        </span>
      )}
    </div>
  )
}

/**
 * The manual fallback for a PR-mode stream ready for delivery whose pull request is not yet known
 * merged: the squad checks delivery itself when the PR merges, so the Review pull request card leaves
 * this out and it lives here. Reads the flow only from cache (the detail view loads it).
 */
function useManualDeliveryCheck(stream: WorkStream, report: (message: string) => void) {
  const { data: run } = useQuery({ ...queries.workflows.run(stream.id), enabled: false })
  const { can } = usePermissions(stream.squadId)
  const refresh = useWorkflowRefresh(stream)
  const finish = useMutation({
    mutationFn: (version: number) => client.workflows.finish(stream.id, version),
    onMutate: () => report('Checking delivery…'),
    onSuccess: () => {
      report('Delivery checked')
      refresh()
    },
    onError: (error) => report(actionErrorMessage(error)),
  })
  const pullRequests = workStreamPullRequests(stream.metadata ?? {})
  const states = readDeliveryState(stream.metadata).pullRequests
  if (
    !run ||
    run.state.status !== 'completion-ready' ||
    !PULL_REQUEST_COMPLETION_MODES.has(run.state.definition.completion.mode) ||
    !pullRequests.length ||
    pullRequests.every((pullRequest) => states[pullRequest.key]?.state === 'merged') ||
    !(can('workstreams:update') || can('workstreams:respond'))
  )
    return null
  return { isPending: finish.isPending, run: () => finish.mutate(run.version) }
}
