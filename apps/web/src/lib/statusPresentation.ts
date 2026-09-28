import type { StatusRole } from '@ficus/shared'
import { readTokenColor } from '../theme/tokenReader'

export interface WebStatusTreatment {
  markerClass: string
  markerToken: string
  /** Numeric CSS color, resolved lazily for canvas/WebGL (CSS var() is not supported there). */
  readonly markerColor: string
  textClass: string
  surfaceClass: string
  borderClass: string
  badgeColor: StatusRole
}

/** Read at use time, never snapshot a palette at module import. */
export function readStatusMarkerColor(token: string, root?: Element): string {
  const element = root ?? (typeof document === 'undefined' ? undefined : document.documentElement)
  const style = element?.ownerDocument.defaultView?.getComputedStyle(element)
  return (style && readTokenColor(style, token)) || 'transparent'
}

export const WEB_STATUS = {
  progress: {
    markerClass: 'bg-status-progress-solid',
    markerToken: '--status-progress-solid',
    get markerColor() {
      return readStatusMarkerColor('--status-progress-solid')
    },
    textClass: 'text-status-progress-fg',
    surfaceClass: 'bg-status-progress-surface',
    borderClass: 'border-status-progress-border',
    badgeColor: 'progress',
  },
  queue: {
    markerClass: 'bg-status-queue-solid',
    markerToken: '--status-queue-solid',
    get markerColor() {
      return readStatusMarkerColor('--status-queue-solid')
    },
    textClass: 'text-status-queue-fg',
    surfaceClass: 'bg-status-queue-surface',
    borderClass: 'border-status-queue-border',
    badgeColor: 'queue',
  },
  review: {
    markerClass: 'bg-status-review-solid',
    markerToken: '--status-review-solid',
    get markerColor() {
      return readStatusMarkerColor('--status-review-solid')
    },
    textClass: 'text-status-review-fg',
    surfaceClass: 'bg-status-review-surface',
    borderClass: 'border-status-review-border',
    badgeColor: 'review',
  },
  humanWait: {
    markerClass: 'bg-status-human-wait-solid',
    markerToken: '--status-human-wait-solid',
    get markerColor() {
      return readStatusMarkerColor('--status-human-wait-solid')
    },
    textClass: 'text-status-human-wait-fg',
    surfaceClass: 'bg-status-human-wait-surface',
    borderClass: 'border-status-human-wait-border',
    badgeColor: 'humanWait',
  },
  externalWait: {
    markerClass: 'bg-status-external-wait-solid',
    markerToken: '--status-external-wait-solid',
    get markerColor() {
      return readStatusMarkerColor('--status-external-wait-solid')
    },
    textClass: 'text-status-external-wait-fg',
    surfaceClass: 'bg-status-external-wait-surface',
    borderClass: 'border-status-external-wait-border',
    badgeColor: 'externalWait',
  },
  attention: {
    markerClass: 'bg-status-attention-solid',
    markerToken: '--status-attention-solid',
    get markerColor() {
      return readStatusMarkerColor('--status-attention-solid')
    },
    textClass: 'text-status-attention-fg',
    surfaceClass: 'bg-status-attention-surface',
    borderClass: 'border-status-attention-border',
    badgeColor: 'attention',
  },
  danger: {
    markerClass: 'bg-status-danger-solid',
    markerToken: '--status-danger-solid',
    get markerColor() {
      return readStatusMarkerColor('--status-danger-solid')
    },
    textClass: 'text-status-danger-fg',
    surfaceClass: 'bg-status-danger-surface',
    borderClass: 'border-status-danger-border',
    badgeColor: 'danger',
  },
  success: {
    markerClass: 'bg-status-success-solid',
    markerToken: '--status-success-solid',
    get markerColor() {
      return readStatusMarkerColor('--status-success-solid')
    },
    textClass: 'text-status-success-fg',
    surfaceClass: 'bg-status-success-surface',
    borderClass: 'border-status-success-border',
    badgeColor: 'success',
  },
  neutral: {
    markerClass: 'bg-status-neutral-solid',
    markerToken: '--status-neutral-solid',
    get markerColor() {
      return readStatusMarkerColor('--status-neutral-solid')
    },
    textClass: 'text-status-neutral-fg',
    surfaceClass: 'bg-status-neutral-surface',
    borderClass: 'border-status-neutral-border',
    badgeColor: 'neutral',
  },
} as const satisfies Record<StatusRole, WebStatusTreatment>

export function webStatus(role: StatusRole): WebStatusTreatment {
  return WEB_STATUS[role]
}
