import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type {
  GitHubAccountIdentity,
  GitHubFeedbackDetail,
  GitHubFeedbackListItem,
  GitHubFeedbackQueue,
  GitHubFeedbackSelection,
  ModerateGitHubFeedback,
} from '@ficus/shared'
import { Modal } from '../Modal'
import { ApiError } from '../../api/client'
import {
  githubFeedbackErrorCode,
  githubFeedbackErrorMessage,
  moderateGitHubFeedback,
  retryGitHubFeedbackRelease,
} from '../../api/githubFeedback'
import { githubFeedbackQueries } from '../../queryOptions'
import { githubFeedbackQueryKeys } from '../../queryKeys'
import {
  ACTION_DONE,
  RELEASE_LABELS,
  authorLabel,
  formatTime,
  kindLabel,
  reasonLabel,
  safeGitHubUrl,
  target,
  trustOriginLabel,
} from './githubFeedbackLabels'

/** Server bulk cap: one decision request carries at most 50 reviewed versions. */
export const MAX_GITHUB_FEEDBACK_SELECTION = 50

type Action = ModerateGitHubFeedback['action']

/**
 * A reviewed version, captured when the human selected it. Refetches never rewrite it: a newer edit
 * of the same event is a different version that must be reviewed and selected again.
 */
interface SelectedVersion extends GitHubFeedbackSelection {
  author: GitHubAccountIdentity | null
  contentAvailable: boolean
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])'

export function GitHubFeedbackReviewModal({
  squadId,
  isOpen,
  onClose,
  initialQueue = 'pending',
}: {
  squadId: string
  isOpen: boolean
  onClose: () => void
  initialQueue?: GitHubFeedbackQueue
}) {
  const client = useQueryClient()
  const [queue, setQueue] = useState<GitHubFeedbackQueue>(initialQueue)
  const [focusedId, setFocusedId] = useState<string | null>(null)
  const [selected, setSelected] = useState<Map<string, SelectedVersion>>(() => new Map())
  const [confirmTrust, setConfirmTrust] = useState(false)
  const [status, setStatus] = useState<{ tone: 'info' | 'error'; text: string } | null>(null)
  // The list's `contentAvailable` only means content was captured; `source_access_unavailable`
  // (lost GitHub access) can still withhold it. Detail is the only place that tells us, so track
  // every revision a fetched detail has shown as withheld, independent of whether it's selected.
  const [withheldIds, setWithheldIds] = useState<Set<string>>(() => new Set())
  // Each opening starts on the requested queue; selections deliberately survive close/reopen.
  const [wasOpen, setWasOpen] = useState(isOpen)
  // Set whenever the dialog just (re)opened; consumed once the pending list has refetched, so a
  // selection decided by someone else while this was closed stops counting toward the 50 cap.
  const pruneOnReopen = useRef(false)
  if (isOpen !== wasOpen) {
    setWasOpen(isOpen)
    if (isOpen) {
      setQueue(initialQueue)
      setFocusedId(null)
      pruneOnReopen.current = true
    }
  }
  // An unconfirmed (network/5xx) attempt keeps its request ID so a retry is idempotent server-side.
  const unconfirmed = useRef<{ key: string; requestId: string } | null>(null)
  const dialogRoot = useRef<HTMLDivElement>(null)

  const summary = useQuery({ ...githubFeedbackQueries.summary(squadId), enabled: isOpen })
  const list = useInfiniteQuery({ ...githubFeedbackQueries.list(squadId, queue), enabled: isOpen })
  const rows = useMemo(() => list.data?.pages.flatMap((page) => page.items) ?? [], [list.data])
  const canModerate = list.data?.pages[0]?.canModerate ?? summary.data?.canModerate ?? false
  const detail = useQuery({
    ...githubFeedbackQueries.detail(squadId, focusedId ?? ''),
    enabled: isOpen && !!focusedId,
  })

  useEffect(() => {
    if (!detail.data) return
    const id = detail.data.id
    const withheld = !!detail.data.contentWithheld
    setWithheldIds((current) => {
      if (current.has(id) === withheld) return current
      const next = new Set(current)
      if (withheld) next.add(id)
      else next.delete(id)
      return next
    })
  }, [detail.data])

  // Reopening re-enables the pending list query; refetch it explicitly (refetch() ignores
  // `enabled`) and prune against its result rather than guessing when an incidental
  // refetch-on-mount lands.
  useEffect(() => {
    if (!isOpen || queue !== 'pending' || !pruneOnReopen.current) return
    pruneOnReopen.current = false
    void list.refetch().then((result) => {
      const freshRows = result.data?.pages.flatMap((page) => page.items) ?? []
      const stillPending = new Set(freshRows.map((row) => row.id))
      setSelected((current) => new Map([...current].filter(([id]) => stillPending.has(id))))
    })
    // `list` itself isn't a meaningful dependency (a new object every render); only `refetch`'s
    // behavior matters here, and it closes over the current queue/squadId already.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, queue])

  // Tab stays inside the dialog. Both "activeElement is the dialog root" (the resting focus right
  // after open) and "activeElement is outside the dialog entirely" count as wrap cases, in either
  // direction — not just the usual first/last-element bounce.
  useEffect(() => {
    if (!isOpen) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return
      const dialog = dialogRoot.current?.closest<HTMLElement>('[role="dialog"]')
      if (!dialog) return
      const focusable = [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)]
      if (focusable.length === 0) return
      const first = focusable[0]!
      const last = focusable[focusable.length - 1]!
      const active = document.activeElement
      const atEdgeOrOutside = active === dialog || !dialog.contains(active)
      if (event.shiftKey && (active === first || atEdgeOrOutside)) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && (active === last || atEdgeOrOutside)) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [isOpen])

  // The shared Modal handles Escape (closeOnEscape below): topmost-dialog, defaultPrevented and
  // isComposing all apply there. This only intercepts Escape, in the capture phase, to back out of
  // the trust confirmation instead of closing — the same convention popups use to consume Escape
  // before Modal's own bubble-phase listener sees it (see Modal.tsx).
  useEffect(() => {
    if (!isOpen || !confirmTrust) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.isComposing) return
      event.preventDefault()
      event.stopPropagation()
      setConfirmTrust(false)
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => document.removeEventListener('keydown', onKeyDown, true)
  }, [isOpen, confirmTrust])

  const refresh = () => client.invalidateQueries({ queryKey: githubFeedbackQueryKeys.squad(squadId) })

  const decide = useMutation({
    mutationFn: async (action: Action) => {
      const selections = [...selected.values()]
        .map(({ revisionId, contentHash, decisionVersion }) => ({ revisionId, contentHash, decisionVersion }))
        .sort((a, b) => a.revisionId.localeCompare(b.revisionId))
      const key = JSON.stringify([action, selections])
      if (unconfirmed.current?.key !== key) unconfirmed.current = { key, requestId: crypto.randomUUID() }
      const response = await moderateGitHubFeedback(squadId, {
        requestId: unconfirmed.current.requestId,
        action,
        selections,
      })
      return { action, ids: selections.map((selection) => selection.revisionId), response }
    },
    onMutate: () => setStatus(null),
    onSuccess: async ({ action, ids }) => {
      unconfirmed.current = null
      setConfirmTrust(false)
      setSelected((current) => {
        const next = new Map(current)
        for (const id of ids) next.delete(id)
        return next
      })
      // A decided event leaves the pending queue; don't keep showing it as if it were still held.
      setFocusedId((current) => (current && ids.includes(current) ? null : current))
      setStatus({
        tone: 'info',
        text:
          action === 'deny'
            ? `${ids.length} ${ids.length === 1 ? 'event' : 'events'} denied. ${ids.length === 1 ? 'It' : 'They'} will not reach agents.`
            : `${ids.length} ${ids.length === 1 ? 'event' : 'events'} ${ACTION_DONE[action]}. Release is queued; follow progress under Releasing.`,
      })
      await refresh()
    },
    onError: async (error) => {
      const definitive = error instanceof ApiError && error.status >= 400 && error.status < 500
      if (definitive) unconfirmed.current = null
      setConfirmTrust(false)
      if (!definitive) {
        setStatus({
          tone: 'error',
          text: "We couldn't confirm the decision was saved. Retrying sends the same request, so it can't be applied twice.",
        })
        return
      }
      setStatus({ tone: 'error', text: githubFeedbackErrorMessage(error, "Couldn't save the decision.") })
      if (!githubFeedbackErrorCode(error)?.startsWith('moderation_')) return
      await refresh()
      // Events someone else already decided have left the pending queue and can no longer be seen or
      // unchecked; drop them. Still-pending selections stay bound to the version the person reviewed.
      const pending = client.getQueryData(githubFeedbackQueries.list(squadId, 'pending').queryKey)
      if (!pending) return
      const stillPending = new Set(pending.pages.flatMap((page) => page.items.map((item) => item.id)))
      setSelected((current) => new Map([...current].filter(([id]) => stillPending.has(id))))
    },
  })

  const retry = useMutation({
    mutationFn: (revisionId: string) => retryGitHubFeedbackRelease(squadId, revisionId),
    onMutate: () => setStatus(null),
    onSuccess: async () => {
      setStatus({ tone: 'info', text: 'Retry queued.' })
      await refresh()
    },
    onError: (error) =>
      setStatus({ tone: 'error', text: githubFeedbackErrorMessage(error, "Couldn't queue a retry.") }),
  })

  const toggle = (version: GitHubFeedbackListItem | GitHubFeedbackDetail) => {
    setStatus(null)
    setSelected((current) => {
      const next = new Map(current)
      if (next.has(version.id)) next.delete(version.id)
      else if (next.size < MAX_GITHUB_FEEDBACK_SELECTION)
        next.set(version.id, {
          revisionId: version.id,
          contentHash: version.contentHash,
          decisionVersion: version.decisionVersion,
          author: version.author,
          contentAvailable: version.contentAvailable,
        })
      return next
    })
  }
  const selectAllShown = () => {
    setSelected((current) => {
      const next = new Map(current)
      for (const row of rows) {
        if (next.size >= MAX_GITHUB_FEEDBACK_SELECTION) break
        if (!next.has(row.id))
          next.set(row.id, {
            revisionId: row.id,
            contentHash: row.contentHash,
            decisionVersion: row.decisionVersion,
            author: row.author,
            contentAvailable: row.contentAvailable,
          })
      }
      return next
    })
  }

  const selection = [...selected.values()]
  const trustAuthors = [
    ...new Map(selection.flatMap((s) => (s.author ? [[s.author.accountId, s.author]] : []))).values(),
  ]
  const allContentAvailable = selection.every((s) => s.contentAvailable && !withheldIds.has(s.revisionId))
  const allAuthorsKnown = selection.every((s) => s.author)
  const busy = decide.isPending
  const moderating = canModerate && queue === 'pending'
  const pendingCount = summary.data?.pending
  const releasingCount = summary.data?.releasing

  const switchQueue = (next: GitHubFeedbackQueue) => {
    setQueue(next)
    setFocusedId(null)
    setConfirmTrust(false)
  }
  // Decisions are explicit button clicks only; Enter inside read-only content never submits.
  const swallowEnter = (event: ReactKeyboardEvent) => {
    const tag = (event.target as Element).tagName
    if (event.key === 'Enter' && tag !== 'BUTTON' && tag !== 'A' && tag !== 'SUMMARY') event.preventDefault()
  }

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Review GitHub events"
      maxWidth="wide"
      size="viewport"
      mobileFullscreen
      noChildPadding
      closeOnEscape
      footer={
        moderating ? (
          <div className="space-y-3">
            {confirmTrust && (
              <div role="group" aria-label="Confirm trusting authors" className="ficus-inset space-y-2 p-3 text-sm">
                <p className="text-primary">
                  Future GitHub feedback from {trustAuthors.map((author) => authorLabel(author)).join(', ')} will reach
                  agents in this squad without review. The selected {selection.length === 1 ? 'event is' : 'events are'}{' '}
                  released; their other pending events are not released.
                </p>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    className="ficus-button ficus-button-primary px-3 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-50"
                    disabled={busy || !allContentAvailable || !allAuthorsKnown}
                    onClick={() => decide.mutate('allow_trust')}
                  >
                    Allow and trust {trustAuthors.length} {trustAuthors.length === 1 ? 'author' : 'authors'}
                  </button>
                  <button
                    type="button"
                    className="ficus-button ficus-button-secondary px-3 py-2 text-sm"
                    onClick={() => setConfirmTrust(false)}
                  >
                    Back
                  </button>
                </div>
              </div>
            )}
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-3">
                <p className="text-sm text-muted" aria-live="polite">
                  {selection.length} selected
                  {selection.length >= MAX_GITHUB_FEEDBACK_SELECTION && ` (limit ${MAX_GITHUB_FEEDBACK_SELECTION})`}
                </p>
                {selection.length > 0 && (
                  <button
                    type="button"
                    className="text-sm text-accent-light hover:underline disabled:opacity-50"
                    disabled={busy}
                    onClick={() => {
                      setStatus(null)
                      setSelected(new Map())
                    }}
                  >
                    Clear selection
                  </button>
                )}
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  className="ficus-button ficus-button-secondary px-3 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-50"
                  disabled={busy || selection.length === 0}
                  onClick={() => decide.mutate('deny')}
                >
                  Deny
                </button>
                <button
                  type="button"
                  className="ficus-button ficus-button-secondary px-3 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-50"
                  disabled={busy || selection.length === 0 || !allContentAvailable}
                  onClick={() => decide.mutate('allow_once')}
                >
                  Allow once
                </button>
                <button
                  type="button"
                  className="ficus-button ficus-button-primary px-3 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-50"
                  disabled={busy || selection.length === 0 || !allContentAvailable || !allAuthorsKnown || confirmTrust}
                  onClick={() => setConfirmTrust(true)}
                >
                  Allow and trust author
                </button>
              </div>
            </div>
            {selection.length > 0 && (!allContentAvailable || !allAuthorsKnown) && (
              <p className="text-xs text-muted">
                Some selected events have unavailable content or an unknown author. They can only be denied.
              </p>
            )}
          </div>
        ) : undefined
      }
    >
      <div ref={dialogRoot} className="flex min-h-0 flex-1 flex-col">
        <div className="flex flex-wrap items-center gap-2 border-b border-panel-border px-4 py-2" role="tablist">
          {(['pending', 'releasing'] as const).map((name) => {
            const count = name === 'pending' ? pendingCount : releasingCount
            return (
              <button
                key={name}
                type="button"
                role="tab"
                aria-selected={queue === name}
                className={`ficus-button px-3 py-1.5 text-sm ${queue === name ? 'ficus-button-primary' : 'ficus-button-secondary'}`}
                onClick={() => switchQueue(name)}
              >
                {name === 'pending' ? 'Pending' : 'Releasing'}
                {count !== undefined ? ` (${count})` : ''}
              </button>
            )
          })}
          {moderating && rows.length > 0 && (
            <button
              type="button"
              className="ficus-button ficus-button-ghost ml-auto rounded-lg px-2 py-1.5 text-xs text-accent-light"
              onClick={selectAllShown}
            >
              Select all shown
            </button>
          )}
        </div>
        {!canModerate && list.isSuccess && (
          <p className="border-b border-panel-border px-4 py-2 text-sm text-muted">
            You can view these events, but you need permission to update this squad to allow or deny them.
          </p>
        )}
        {status && (
          <p
            role={status.tone === 'error' ? 'alert' : 'status'}
            className={`border-b border-panel-border px-4 py-2 text-sm ${status.tone === 'error' ? 'text-status-danger-600 dark:text-status-danger-400' : 'text-primary'}`}
          >
            {status.text}
          </p>
        )}
        <div className="grid min-h-0 flex-1 md:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
          <div
            className={`min-h-0 overflow-y-auto border-panel-border md:border-r ${focusedId ? 'hidden md:block' : ''}`}
          >
            {list.isPending && (
              <p role="status" className="p-4 text-sm text-muted">
                Loading GitHub events…
              </p>
            )}
            {list.isError && (
              <div role="alert" className="space-y-2 p-4 text-sm text-status-danger-600 dark:text-status-danger-400">
                <p>{githubFeedbackErrorMessage(list.error, "Couldn't load GitHub events.")}</p>
                <button
                  type="button"
                  className="ficus-button ficus-button-secondary px-3 py-1.5"
                  onClick={() => list.refetch()}
                >
                  Try again
                </button>
              </div>
            )}
            {list.isSuccess && rows.length === 0 && (
              <p role="status" className="p-4 text-sm text-muted">
                {queue === 'pending'
                  ? 'No GitHub events are waiting for review.'
                  : 'Nothing is waiting to be released.'}
              </p>
            )}
            <ul className="divide-y divide-panel-border">
              {rows.map((row) => {
                const chosen = selected.get(row.id)
                const changed =
                  chosen && (chosen.contentHash !== row.contentHash || chosen.decisionVersion !== row.decisionVersion)
                return (
                  <li
                    key={row.id}
                    className={`flex items-start gap-3 px-4 py-3 ${focusedId === row.id ? 'bg-surface-hover' : ''}`}
                  >
                    {moderating && (
                      <input
                        type="checkbox"
                        className="mt-1"
                        data-revision-id={row.id}
                        // kind + author alone collide whenever the same person triggers the same
                        // kind of event twice; target + time (always distinct per revision) keep
                        // every row's checkbox label unique.
                        aria-label={`Select ${kindLabel(row).toLowerCase()} by ${authorLabel(row.author)}, ${target(row)}, ${formatTime(row.firstObservedAt)}`}
                        checked={!!chosen}
                        disabled={!chosen && selected.size >= MAX_GITHUB_FEEDBACK_SELECTION}
                        onChange={() => toggle(row)}
                      />
                    )}
                    <button
                      type="button"
                      className="min-w-0 flex-1 text-left"
                      data-revision-id={row.id}
                      aria-current={focusedId === row.id ? 'true' : undefined}
                      onClick={() => setFocusedId(row.id)}
                    >
                      <span className="block truncate text-sm text-primary">
                        {authorLabel(row.author)} · {kindLabel(row)}
                      </span>
                      <span className="block truncate text-xs text-muted">
                        {target(row)} · {formatTime(row.firstObservedAt)}
                      </span>
                      <span className="block truncate text-xs text-muted">
                        {queue === 'releasing'
                          ? `${RELEASE_LABELS[row.releaseState]}${row.attempts ? ` · ${row.attempts} attempts` : ''}`
                          : reasonLabel(row.reason)}
                      </span>
                      {changed && (
                        <span className="mt-1 block text-xs text-status-warning-600 dark:text-status-warning-400">
                          Changed since you selected it. Your selection still refers to the version you reviewed.
                        </span>
                      )}
                    </button>
                  </li>
                )
              })}
            </ul>
            {list.hasNextPage && (
              <div className="p-3">
                <button
                  type="button"
                  className="ficus-button ficus-button-secondary w-full px-3 py-2 text-sm"
                  disabled={list.isFetchingNextPage}
                  onClick={() => list.fetchNextPage()}
                >
                  {list.isFetchingNextPage ? 'Loading…' : 'Load more'}
                </button>
              </div>
            )}
          </div>
          <div
            className={`min-h-0 overflow-y-auto ${focusedId ? '' : 'hidden md:block'}`}
            aria-label="Event details"
            role="region"
            onKeyDown={swallowEnter}
          >
            {!focusedId && (
              <p className="p-4 text-sm text-muted">Choose an event to see exactly what would reach agents.</p>
            )}
            {focusedId && (
              <div className="p-4 pb-0 md:hidden">
                <button
                  type="button"
                  className="ficus-button ficus-button-link text-xs text-accent-light"
                  onClick={() => setFocusedId(null)}
                >
                  ← Back to list
                </button>
              </div>
            )}
            {focusedId && (
              <div className="space-y-4 p-4">
                {detail.isPending && (
                  <p role="status" className="text-sm text-muted">
                    Loading event…
                  </p>
                )}
                {detail.isError && (
                  <p role="alert" className="text-sm text-status-danger-600 dark:text-status-danger-400">
                    {githubFeedbackErrorMessage(detail.error, "Couldn't load this event.")}
                  </p>
                )}
                {detail.data && (
                  <EventDetail
                    detail={detail.data}
                    selectedVersion={selected.get(detail.data.id)}
                    moderating={moderating}
                    selectionFull={selected.size >= MAX_GITHUB_FEEDBACK_SELECTION}
                    onToggle={() => toggle(detail.data)}
                    onRetry={() => retry.mutate(detail.data.id)}
                    retrying={retry.isPending}
                  />
                )}
              </div>
            )}
          </div>
        </div>
        {queue === 'releasing' &&
          canModerate &&
          rows.some((row) => row.releaseState === 'retry' || row.releaseState === 'retained') &&
          !focusedId && (
            <p className="border-t border-panel-border px-4 py-2 text-xs text-muted">
              Open an event to retry its release now.
            </p>
          )}
      </div>
    </Modal>
  )
}

function EventDetail({
  detail,
  selectedVersion,
  moderating,
  selectionFull,
  onToggle,
  onRetry,
  retrying,
}: {
  detail: GitHubFeedbackDetail
  selectedVersion: SelectedVersion | undefined
  moderating: boolean
  selectionFull: boolean
  onToggle: () => void
  onRetry: () => void
  retrying: boolean
}) {
  const url = safeGitHubUrl(detail.url)
  const sameVersion =
    selectedVersion &&
    selectedVersion.contentHash === detail.contentHash &&
    selectedVersion.decisionVersion === detail.decisionVersion
  const canRetry = detail.canModerate && (detail.releaseState === 'retry' || detail.releaseState === 'retained')
  return (
    <>
      <div className="space-y-1">
        <h4 className="text-sm font-semibold text-primary">
          {kindLabel(detail)} by {authorLabel(detail.author)}
        </h4>
        <p className="text-xs text-muted">
          {target(detail)} · first seen {formatTime(detail.firstObservedAt)}
          {detail.updatedAt !== detail.firstObservedAt && ` · updated ${formatTime(detail.updatedAt)}`}
        </p>
        {url && (
          <a className="text-xs text-accent-light hover:underline" href={url} target="_blank" rel="noopener noreferrer">
            Open on GitHub
          </a>
        )}
      </div>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
        <dt className="text-muted">{detail.decision === 'pending' ? 'Why held' : 'Reason'}</dt>
        <dd className="text-primary">{reasonLabel(detail.reason) ?? '—'}</dd>
        <dt className="text-muted">Author trust</dt>
        <dd className="text-primary">
          {detail.authorTrust.length
            ? detail.authorTrust.map(trustOriginLabel).join('; ')
            : 'Not trusted in this squad'}
        </dd>
        {detail.editor && detail.editor.accountId !== detail.author?.accountId && (
          <>
            <dt className="text-muted">Edited by</dt>
            <dd className="text-primary">
              {authorLabel(detail.editor)} ·{' '}
              {detail.editorTrust.length
                ? detail.editorTrust.map(trustOriginLabel).join('; ')
                : 'Not trusted in this squad'}
            </dd>
          </>
        )}
        {detail.attribution !== 'creation' && (
          <>
            <dt className="text-muted">Attribution</dt>
            <dd className="text-primary">
              {detail.attribution === 'verified_edit' ? 'Verified edit' : 'Editor could not be verified'}
            </dd>
          </>
        )}
        <dt className="text-muted">Status</dt>
        <dd className="text-primary">
          {RELEASE_LABELS[detail.releaseState]}
          {detail.attempts ? ` · ${detail.attempts} delivery attempts` : ''}
          {detail.decidedAt && ` · decided ${formatTime(detail.decidedAt)}`}
        </dd>
        <dt className="text-muted">Matched when held</dt>
        <dd className="text-primary">
          {detail.routes.length === 0 ? (
            'Current routing is decided when it is released'
          ) : (
            <ul>
              {detail.routes.map((route) => (
                <li key={`${route.kind}:${route.id}`} className="break-all">
                  {route.kind.replace(/_/g, ' ')}
                  {route.workStreamId && ` · work ${route.workStreamId}`}
                  {route.recipientId && ` · agent ${route.recipientId}`}
                </li>
              ))}
            </ul>
          )}
          {detail.routes.length > 0 && (
            <p className="text-xs text-muted">If allowed, it goes to whoever should receive it at that time.</p>
          )}
        </dd>
      </dl>
      {detail.content ? (
        <div className="space-y-2">
          <p className="text-xs font-medium text-muted">
            Exact content to be released
            {detail.content.path
              ? ` · ${detail.content.path}${detail.content.line ? `:${detail.content.line}` : ''}`
              : ''}
          </p>
          {detail.content.title && (
            <p className="text-sm font-medium text-primary break-words">{detail.content.title}</p>
          )}
          {/* External text is rendered as plain text only; markdown, HTML and links stay inert. */}
          <pre className="ficus-inset max-h-80 overflow-auto whitespace-pre-wrap break-words p-3 text-xs text-primary">
            {detail.content.body || '(empty)'}
          </pre>
          <details className="text-xs">
            <summary className="cursor-pointer text-muted">Agent-facing message</summary>
            <pre className="ficus-inset mt-2 max-h-60 overflow-auto whitespace-pre-wrap break-words p-3 text-primary">
              {detail.content.deliveryText}
            </pre>
            {detail.content.deliveryTruncated && (
              <p className="mt-1 text-muted">This message is truncated for delivery.</p>
            )}
          </details>
        </div>
      ) : (
        <p className="ficus-inset p-3 text-sm text-muted">
          {detail.contentWithheld === 'source_access_unavailable'
            ? 'Content is hidden because this squad no longer has access to the GitHub connection it came from. It can still be denied.'
            : 'Content could not be read from GitHub. It can only be denied.'}
        </p>
      )}
      {moderating && detail.decision === 'pending' && (
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={!!sameVersion}
            disabled={(!selectedVersion && selectionFull) || (!!selectedVersion && !sameVersion)}
            onChange={onToggle}
          />
          {selectedVersion && !sameVersion
            ? 'A different version of this event is selected. Clear it from the list to select this one.'
            : 'Select this version'}
        </label>
      )}
      {canRetry && (
        <button
          type="button"
          className="ficus-button ficus-button-secondary px-3 py-2 text-sm"
          disabled={retrying}
          onClick={onRetry}
        >
          Retry now
        </button>
      )}
    </>
  )
}
