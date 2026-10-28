import type { CompactionResult } from '@earendil-works/pi-coding-agent'

export type PrecompactionLifecycleKind =
  'started' | 'succeeded' | 'failed' | 'aborted' | 'superseded' | 'consumed' | 'rejected'

export type PrecompactionRejectReason = 'model' | 'settings' | 'cutpoint' | 'latestCompaction' | 'prefix'

export interface PrecompactionLifecycleStats {
  contextTokens: number
  contextWindow: number
  reserveTokens: number
  earlyMarginTokens: number
}

export interface PrecompactionLifecycleResult {
  tokensBefore?: number
  firstKeptEntryId?: string
}

export type PrecompactionLifecycleEvent =
  | ({ kind: 'started' } & PrecompactionLifecycleStats)
  | ({ kind: 'succeeded'; elapsedMs: number; result?: PrecompactionLifecycleResult } & PrecompactionLifecycleStats)
  | ({ kind: 'failed'; elapsedMs: number; error?: string } & PrecompactionLifecycleStats)
  | ({ kind: 'aborted'; elapsedMs: number } & PrecompactionLifecycleStats)
  | ({ kind: 'superseded'; elapsedMs: number } & PrecompactionLifecycleStats)
  | { kind: 'consumed'; firstKeptEntryId: string }
  | { kind: 'rejected'; reason: PrecompactionRejectReason }

export function compactionResultDebug(result: CompactionResult): PrecompactionLifecycleResult {
  return {
    tokensBefore: result.tokensBefore,
    firstKeptEntryId: result.firstKeptEntryId,
  }
}

export function formatPrecompactionSystemMessage(event: PrecompactionLifecycleEvent): string | undefined {
  switch (event.kind) {
    case 'started':
      return 'Precompaction started'
    case 'succeeded':
      return 'Precompaction finished'
    case 'failed':
    case 'aborted':
    case 'superseded':
    case 'consumed':
    case 'rejected':
      return undefined // log-only; never shown as a chat system message
  }
}

export function formatPrecompactionLogLine(event: PrecompactionLifecycleEvent): string {
  if (event.kind === 'consumed') return `Precompaction consumed firstKeptEntryId=${event.firstKeptEntryId}`
  if (event.kind === 'rejected') return `Precompaction rejected reason=${event.reason}`

  const earlyThreshold = event.contextWindow - event.reserveTokens - event.earlyMarginTokens
  const parts = [
    `Precompaction ${event.kind}`,
    `contextTokens=${event.contextTokens}`,
    `contextWindow=${event.contextWindow}`,
    `reserveTokens=${event.reserveTokens}`,
    `earlyMarginTokens=${event.earlyMarginTokens}`,
    `earlyThreshold=${earlyThreshold}`,
  ]

  if ('elapsedMs' in event) {
    parts.push(`elapsedMs=${Math.round(event.elapsedMs)}`)
  }

  if (event.kind === 'succeeded' && event.result) {
    if (event.result.tokensBefore !== undefined) parts.push(`tokensBefore=${event.result.tokensBefore}`)
    if (event.result.firstKeptEntryId) parts.push(`firstKeptEntryId=${event.result.firstKeptEntryId}`)
  }

  if (event.kind === 'failed' && event.error) {
    parts.push(`error=${event.error}`)
  }

  return parts.join(' ')
}
