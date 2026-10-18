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
  /** The last "remove now" request for this dormancy was given up after repeated failures. */
  removalError?: string
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
  /** Top-level box homes: when this value was measured (ISO). Absent before incremental scanning. */
  measuredAt?: string
  /** Top-level box homes: measured in the current pass, or carried over from a previous pass. */
  freshness?: 'current' | 'previous'
  /**
   * Top-level box homes: true when bytes came from one measurement of the whole home (a file
   * hard-linked into several folders counted once); false when it is the sum of separately measured
   * folders, where such a file may be counted more than once. Absent before exact totals.
   */
  totalExact?: boolean
  /** Top-level box homes: change against an earlier retained measurement. */
  growth?: StorageGrowth
}

/** Change in measured bytes since an earlier measurement (negative when it shrank). */
export interface StorageGrowth {
  bytes: number
  /** When the earlier measurement was taken (ISO). */
  since: string
}

/** Progress of a machine's continuous, incremental storage scan. */
export interface StorageScanProgress {
  /** running: a pass is measuring; idle: waiting for the next pass. */
  state: 'running' | 'idle'
  /** Pass number, increasing per machine. */
  generation: number
  passStartedAt: string
  /** When the most recent complete pass finished, if any. */
  lastCompletedAt: string | null
  /** Box homes fully measured in this pass. */
  measuredHomes: number
  /** Box homes queued in this pass. */
  totalHomes: number
}

export interface StorageSquad {
  id: string
  name: string
  bytes: number | null
  status: 'available' | 'partial' | 'unavailable'
  folders: StorageFolder[]
  /** False when any of its box homes' totals is approximate (see StorageFolder.totalExact). */
  totalExact?: boolean
  /** Sum of the box homes' growth, since the earliest of their baselines. */
  growth?: StorageGrowth
}

export interface StorageMachine {
  id: string
  name: string
  status: 'available' | 'partial' | 'unavailable'
  usedBytes: number | null
  totalBytes: number | null
  squads: StorageSquad[]
  unattributedBytes: number | null
  /** When usedBytes/totalBytes were read (ISO). */
  diskMeasuredAt?: string | null
  /** Change in used disk bytes since an earlier reading. */
  diskGrowth?: StorageGrowth
  scan?: StorageScanProgress
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

/**
 * Default idle threshold, in days, for making idle consultants dormant. Every squad starts
 * with this value (the `squads.consultant_idle_dormancy_days` column default; keep in sync);
 * null there means the squad turned the sweep off.
 */
export const DEFAULT_CONSULTANT_IDLE_DORMANCY_DAYS = 30

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
