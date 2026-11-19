/**
 * Wait selection for the CLI resolve sugar (`approve`, `send-back`,
 * `unblock`): pick the open wait of the target type to resolve.
 *
 * Ambiguity rule (spec: work-stream verbs redesign §1): with MORE THAN ONE
 * open wait of the target type, the sugar REFUSES and requires an explicit
 * `--wait <id>` rather than guessing.
 */

export interface SelectableWait {
  id: string
  type: string
  message: string | null
  openedAt?: string
  /** Stale-target diagnosis only: set on closed waits (from `waitHistory`). */
  closedAt?: string | null
  resolution?: string | null
  resolutionNote?: string | null
}

export class WaitSelectionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WaitSelectionError'
  }
}

/** Wait messages are capped in error listings so one long watchdog message
 * cannot bury the wait ids the operator actually needs. */
const LISTING_MESSAGE_MAX_CHARS = 80

/** Truncates by code points so multibyte characters never split mid-surrogate. */
function truncateForListing(text: string, maxChars = LISTING_MESSAGE_MAX_CHARS): string {
  const chars = [...text]
  return chars.length <= maxChars ? text : chars.slice(0, maxChars).join('') + '…'
}

function describeWait(wait: SelectableWait): string {
  const message = wait.message ? ` — ${truncateForListing(wait.message)}` : ''
  return `  ${wait.id}${message}`
}

function listing(waits: SelectableWait[]): string {
  return waits.map(describeWait).join('\n')
}

/**
 * Find the single CLOSED wait of `type` matching `explicit` (full id or unique
 * prefix). A prefix matching several closed waits is as ambiguous as several
 * open ones — return undefined so the caller falls back to the generic error
 * instead of guessing.
 */
function findClosedWaitByIdPrefix(
  history: SelectableWait[],
  type: string,
  explicit: string
): SelectableWait | undefined {
  const matches = history.filter(
    (w) => w.type === type && w.closedAt && (w.id === explicit || w.id.startsWith(explicit))
  )
  return matches.length === 1 ? matches[0] : undefined
}

/**
 * Stale-target error: `--wait X` named a wait of the target type that is
 * ALREADY closed (e.g. auto-closed by the system when the assignee's
 * execution started, moments before the operator ran the command). This is
 * the exact shape of the 2026-09-02 incident: the generic "no open wait
 * matches" listing read like a no-op and sent the operator re-targeting
 * another wait id, while the resolution note went nowhere. Name the closed
 * wait, its recorded resolution, and that the note was not recorded.
 */
function formatStaleTargetError(
  explicit: string,
  stale: SelectableWait,
  typeLabel: string,
  openCandidates: SelectableWait[]
): string {
  const closedAt = stale.closedAt ? new Date(stale.closedAt).toLocaleString() : null
  const detail = [
    stale.resolution ? `resolution: ${stale.resolution}` : null,
    closedAt ? `closed ${closedAt}` : null,
    stale.resolutionNote ? `recorded note: ${JSON.stringify(truncateForListing(stale.resolutionNote))}` : null,
  ]
    .filter(Boolean)
    .join('; ')
  const remaining =
    openCandidates.length > 0
      ? ` Open ${typeLabel} waits:\n${listing(openCandidates)}`
      : ` There are no open ${typeLabel} waits — nothing to clear.`
  return (
    `--wait ${explicit} names a ${typeLabel} wait that was already closed` +
    (detail ? ` (${detail})` : '') +
    `. Nothing was resolved and your -m/--message note was not recorded.` +
    remaining
  )
}

/**
 * Select exactly one open wait of `type` from `waits`.
 *
 * - `explicitWaitId` set: return the matching open wait of that type (id or
 *   unique prefix), or throw when it does not match exactly one. When it
 *   matches no OPEN wait but names a CLOSED wait of the type (via `history`,
 *   the stream's `waitHistory`), the error says so precisely instead of the
 *   generic no-match listing.
 * - 0 candidates: throw (nothing to resolve).
 * - 1 candidate: return it.
 * - >1 candidates: throw, listing the wait ids and requiring `--wait <id>`.
 */
export function selectOpenWait(
  waits: SelectableWait[] | undefined,
  type: 'review' | 'manual',
  opts: { explicitWaitId?: string; typeLabel: string; history?: SelectableWait[] | undefined }
): SelectableWait {
  const candidates = (waits ?? []).filter((w) => w.type === type)

  if (opts.explicitWaitId) {
    const explicit = opts.explicitWaitId
    const matches = candidates.filter((w) => w.id === explicit || w.id.startsWith(explicit))
    if (matches.length === 0) {
      const stale = findClosedWaitByIdPrefix(opts.history ?? [], type, explicit)
      if (stale) {
        throw new WaitSelectionError(formatStaleTargetError(explicit, stale, opts.typeLabel, candidates))
      }
      throw new WaitSelectionError(
        `No open ${opts.typeLabel} wait matches --wait ${explicit}` +
          (candidates.length > 0 ? `. Open ${opts.typeLabel} waits:\n${listing(candidates)}` : '')
      )
    }
    if (matches.length > 1) {
      throw new WaitSelectionError(
        `--wait ${explicit} matches multiple open ${opts.typeLabel} waits — use a full id:\n` + listing(matches)
      )
    }
    return matches[0]
  }

  if (candidates.length === 0) {
    throw new WaitSelectionError(
      `Work stream has no open ${opts.typeLabel} wait to resolve` +
        (type === 'review'
          ? '. A stream with a flow has no review waits: its review steps take outcomes and returns through ficus workstream advance'
          : '')
    )
  }
  if (candidates.length > 1) {
    throw new WaitSelectionError(
      `Work stream has ${candidates.length} open ${opts.typeLabel} waits — pass --wait <id> to pick one:\n` +
        listing(candidates)
    )
  }
  return candidates[0]
}
