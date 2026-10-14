import type { AgentStatus } from './types'

/** Agent whose personal box home a storage folder measures. Dates are ISO strings. */
export interface StorageAgent {
  id: string
  /** Display label (purpose · name, else name, else type). */
  label: string
  agentTypeId: string
  status: AgentStatus
  lastMessageAt: string | null
  dormantAt: string | null
  createdAt: string | null
  /** An operator asked to remove this dormant agent now; the background sweep has not finished yet. */
  removalPending?: boolean
}

/** Read-only, approximate allocated-byte accounting for VM sandbox machines. */
export interface StorageFolder {
  name: string
  path: string
  /** Measured allocation, or null when no part of this directory was measured. */
  bytes: number | null
  status: 'available' | 'partial' | 'unavailable'
  children: StorageFolder[]
  /** Top-level box homes only. Absent on snapshots saved before agent attribution. */
  kind?: 'squad-workspace' | 'agent'
  /** Present on agent box homes whose agent still exists. */
  agent?: StorageAgent
}

export interface StorageSquad {
  id: string
  name: string
  bytes: number | null
  status: 'available' | 'partial' | 'unavailable'
  folders: StorageFolder[]
}

export interface StorageMachine {
  id: string
  name: string
  status: 'available' | 'partial' | 'unavailable'
  usedBytes: number | null
  totalBytes: number | null
  squads: StorageSquad[]
  unattributedBytes: number | null
  diagnostics?: {
    exitCode: number | null
    reasons: Array<
      | 'scan_timeout'
      | 'permission_denied'
      | 'scan_failed'
      | 'incomplete_output'
      | 'missing_home_totals'
      | 'disk_usage_unavailable'
      | 'ssh_timeout'
      | 'ssh_failed'
      | 'machine_not_ready'
    >
    expectedHomes: number
    measuredHomes: number
    missingHomes: string[]
  }
}

export interface StorageSnapshot {
  monitoring?: StorageMonitoring
  /** AGENT_DORMANT_RETENTION_DAYS at read time: dormant agents are removed this long after dormantAt. */
  dormantRetentionDays?: number
  warnings?: StorageWarning[]
  supported: boolean
  scanning: boolean
  scannedAt: string | null
  error: string | null
  machines: StorageMachine[]
}

export interface StorageWarning {
  machineId: string
  machineName: string
  percent: number
  threshold: number
  measuredAt: string
  stale: boolean
}

export interface StorageMonitoring {
  intervalHours: number
  alertsEnabled: boolean
  thresholds: number[]
  nextScanAt: string | null
}

export type StorageStatus = Pick<StorageSnapshot, 'supported' | 'scanning' | 'scannedAt' | 'error'> & {
  monitoring: StorageMonitoring
  warnings: StorageWarning[]
}

/**
 * Agent types never offered manual "Make dormant" from the storage view. The same
 * roles automatic dormancy leaves alone, minus consultants (which may be made dormant).
 */
export const STORAGE_DORMANCY_EXEMPT_AGENT_TYPES: readonly string[] = [
  'manager',
  'system-manager',
  'assistant',
  'assistant-worker',
]

/** Default idle threshold, in days, for making idle consultants dormant. */
export const DEFAULT_CONSULTANT_IDLE_DORMANCY_DAYS = 90

/** One source of files Ficus stores on the core host (counted from database rows, not a disk scan). */
export interface StoredFileSource {
  key: string
  label: string
  /** Whether these bytes count toward INBOX_MAX_TOTAL_STORAGE_BYTES. */
  countsTowardQuota: boolean
  bytes: number
}

export interface StoredFilesSquad {
  id: string
  name: string
  bytes: number
  /** Bytes per source key. */
  sources: Record<string, number>
}

export interface StoredFilesSummary {
  sources: StoredFileSource[]
  squads: StoredFilesSquad[]
  /** Files not attributable to a squad (e.g. user or system inbox attachments). */
  unattributed: { bytes: number; sources: Record<string, number> }
  totalBytes: number
  /** Bytes counted against the quota (sources with countsTowardQuota). */
  quotaUsedBytes: number
  quotaBytes: number
}

export interface IdleConsultant {
  id: string
  label: string
  status: AgentStatus
  lastMessageAt: string | null
  createdAt: string
  /** Latest measured size of the consultant's box home, or null when not measured. */
  bytes: number | null
}

export interface IdleConsultantsPreview {
  days: number
  agents: IdleConsultant[]
}

export interface IdleConsultantsDormancyResult {
  dormant: string[]
  deferred: string[]
  skipped: Array<{ id: string; reason: string }>
}

/** Accepted agents are removed in the background by the next dormant-retention sweep ticks. */
export interface RemoveDormantAgentsResult {
  accepted: string[]
  skipped: Array<{ id: string; reason: string }>
}
