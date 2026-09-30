/**
 * Where Core stores absolute paths under HOME_DIR, for `rebase-home` (scripts/rebase-home.ts): when
 * the host layout migration moves HOME (`/root/<legacy>` → `/root/.ficus`), every stored path under
 * the old HOME is rewritten to the new one in the same run, and back when the migration is reversed.
 *
 * Every text/varchar/jsonb column whose name looks like a path (see PATH_LIKE_COLUMN) must be listed
 * in exactly one of HOME_PATH_COLUMNS or NON_HOME_PATH_COLUMNS: home-path-columns.test.ts walks the
 * schema and fails on a new path column until someone classifies it. Columns with other names are
 * listed here when a review (or the P5-T0 audit of the live fleet) found HOME paths in them.
 *
 * Kinds, and what rebasing one value means (FROM = the old HOME, TO = the new one):
 * - `text`: the whole value is a path. `FROM` itself and `FROM/…` become `TO` and `TO/…`.
 * - `jsonb-string`: the string at `jsonPath` is a path, rebased like `text`. Other keys are kept.
 * - `jsonb-text`: any string in the document may mention paths in free text (tool arguments and
 *   output, prose). Every occurrence of `FROM` that stands on its own — not continuing a longer path
 *   or name on either side — becomes `TO`, including inside JSON encoded in a string.
 */

/** A column that may hold an absolute path under HOME_DIR. */
export interface HomePathColumn {
  table: string
  column: string
  kind: 'text' | 'jsonb-string' | 'jsonb-text'
  /** `jsonb-string` only: the keys leading to the path string. */
  jsonPath?: string[]
}

/** The column names the classification guard covers. */
export const PATH_LIKE_COLUMN = /(path|dir|cwd|worktree|file)$/i

/** The absolute paths a squad worktree's ownership record keeps (`WorktreeOwnership`). */
const WORKTREE_OWNERSHIP_PATHS = ['workspace', 'repository', 'commonDirectory', 'gitDirectory', 'worktree'] as const

export const HOME_PATH_COLUMNS: readonly HomePathColumn[] = [
  // `<HOME>/inbox-attachments/<message>/<attachment>` (attachment-storage.ts). P5-T0 audit: noah 9 rows.
  { table: 'inbox_attachments', column: 'storage_path', kind: 'text' },
  // The agent-visible attachment path; on the host runtime `<HOME>/private/<sandbox>/…`.
  { table: 'agent_file_attachments', column: 'private_path', kind: 'text' },
  // Host runtime: the squad's workspace directory on the core's machine, when set.
  { table: 'squads', column: 'host_workspace_path', kind: 'text' },
  // Memory document paths (normally `/memory/…`); rebased in case one was stored absolute.
  { table: 'memory_documents', column: 'path', kind: 'text' },
  // The sandbox-side working directory and attached log file of an app. On the host runtime the
  // sandbox is the core's machine, and the squad workspace is `<HOME>/workspaces/squads/<id>`.
  { table: 'local_deployments', column: 'cwd', kind: 'text' },
  { table: 'local_deployments', column: 'log_path', kind: 'text' },
  // A monitor's working directory: sandbox-side, so under HOME on the host runtime.
  { table: 'monitors', column: 'cwd', kind: 'text' },
  // Worktree ownership (physical paths in the squad runtime; under HOME on the host runtime), and the
  // copy a pending cleanup job carries.
  ...WORKTREE_OWNERSHIP_PATHS.map(
    (key): HomePathColumn => ({
      table: 'work_stream_worktrees',
      column: 'ownership',
      kind: 'jsonb-string',
      jsonPath: [key],
    })
  ),
  ...WORKTREE_OWNERSHIP_PATHS.map(
    (key): HomePathColumn => ({
      table: 'worktree_cleanup_jobs',
      column: 'removal_input',
      kind: 'jsonb-string',
      jsonPath: ['ownership', key],
    })
  ),
  // The repository and worktree a work stream was set up with (repository-setup.ts).
  { table: 'work_streams', column: 'metadata', kind: 'jsonb-string', jsonPath: ['git', 'repository'] },
  { table: 'work_streams', column: 'metadata', kind: 'jsonb-string', jsonPath: ['git', 'worktree'] },
  // The files a work stream names (a string list).
  { table: 'work_streams', column: 'files', kind: 'jsonb-text' },
  // Message content blocks: tool arguments and results, text and thinking. P5-T0 audit: noah 545
  // rows, chowmein 14.
  { table: 'messages', column: 'metadata', kind: 'jsonb-text' },
]

/** `table.column` pairs whose name looks like a path, reviewed as never holding a HOME_DIR path. */
export const NON_HOME_PATH_COLUMNS: readonly string[] = [
  // The memory path an access was audited for: the virtual `/memory/…` namespace, never a host path.
  'memory_access_audit.resource_path',
]

/** The name rebase-home prints and returns a column's count under. */
export function homePathColumnKey(entry: HomePathColumn): string {
  return [entry.table, entry.column, ...(entry.jsonPath ?? [])].join('.')
}
