import { inArray } from 'drizzle-orm'
import { agents, db } from '../../db'
import { createLogger } from '../../lib/infra/logger'
import { consultantSandboxId } from './consultant-sandbox'
import { getPrivateArchiveRetentionDays } from './private-archive'
import { resolveWorkspaceLayout } from './workspace-layout'

const log = createLogger('consultant-scratch')

/** Inside the shared consultant runtime's private root, beside `conversations/`. */
export const CONSULTANT_SCRATCH_ARCHIVE_DIR = '.conversations-archive'
/** At most once per runtime per process: two small commands, not worth more often. */
export const CONSULTANT_SCRATCH_PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000

const AGENT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DAY_MS = 24 * 60 * 60 * 1000

// Lists real directories under conversations/ (never symlinks). stderr is
// dropped because some runtimes merge it into the returned output.
const LIST_SCRIPT = `cd -- "$1/conversations" 2>/dev/null || exit 0
for d in *; do
  if [ -d "$d" ] && [ ! -L "$d" ]; then printf '%s\\n' "$d"; fi
done`

// $1 private root, $2 now (epoch ms), $3 purge cutoff (epoch ms), $4... agent ids.
// Moves each listed scratch dir to the archive as <id>-<now>, removing the
// per-agent secrets file first like the personal /private archive, then
// deletes archive entries whose trailing epoch is older than the cutoff.
const ARCHIVE_SCRIPT = `root=$1; now=$2; cutoff=$3; shift 3
archive="$root/${CONSULTANT_SCRATCH_ARCHIVE_DIR}"
if [ -L "$archive" ]; then echo "archive dir is a symlink" >&2; exit 1; fi
mkdir -p -- "$archive" || exit 1
archived=0
for id in "$@"; do
  src="$root/conversations/$id"
  if [ -L "$src" ] || [ ! -d "$src" ]; then continue; fi
  if [ -d "$src/.ficus" ] && [ ! -L "$src/.ficus" ]; then rm -f -- "$src/.ficus/agent-secrets.env"; fi
  mv -- "$src" "$archive/$id-$now" && archived=$((archived + 1))
done
purged=0
for entry in "$archive"/*; do
  [ -e "$entry" ] || [ -L "$entry" ] || continue
  ts=\${entry##*-}
  case "$ts" in ''|*[!0-9]*) continue ;; esac
  if [ "$ts" -lt "$cutoff" ]; then rm -rf -- "$entry" && purged=$((purged + 1)); fi
done
printf 'archived=%s purged=%s\\n' "$archived" "$purged"`

type ExecManager = { exec: (sandboxId: string, args: string[]) => Promise<Buffer> }

export type ConsultantScratchPruneDeps = {
  getManager?: () => ExecManager | Promise<ExecManager>
  /** Status of each agent id that still has a row; absent ids were deleted. */
  loadStatuses?: (agentIds: string[]) => Promise<Map<string, string>>
  getRetentionDays?: () => number
  privateRoot?: string
  now?: Date
}

export type ConsultantScratchPruneResult = { kept: number; archived: number; purged: number }

async function loadAgentStatuses(agentIds: string[]): Promise<Map<string, string>> {
  if (!agentIds.length) return new Map()
  const rows = await db
    .select({ id: agents.id, status: agents.status })
    .from(agents)
    .where(inArray(agents.id, agentIds))
  return new Map(rows.map((row) => [row.id, row.status]))
}

/**
 * Archive the scratch of consultants (and their subagents) that are finally
 * terminated or deleted from a squad's shared consultant runtime, and purge
 * archived scratch older than AGENT_PRIVATE_ARCHIVE_RETENTION_DAYS. Live and
 * dormant agents keep their scratch in place, so waking needs no restore.
 * Must only run while the runtime is up; it never starts it.
 */
export async function pruneConsultantScratch(
  squadId: string,
  deps: ConsultantScratchPruneDeps = {}
): Promise<ConsultantScratchPruneResult> {
  const sandboxId = consultantSandboxId(squadId)
  const manager = deps.getManager ? await deps.getManager() : (await import('./factory')).getSandboxManager()
  const root = deps.privateRoot ?? resolveWorkspaceLayout({ sandboxId }).privateMount
  const listed = (await manager.exec(sandboxId, ['sh', '-c', LIST_SCRIPT, 'sh', root]))
    .toString()
    .split('\n')
    .map((line) => line.trim())
    // Anything not named for an agent is left alone (and keeps the IN list valid for a uuid column).
    .filter((name) => AGENT_ID_PATTERN.test(name))
  const statuses = await (deps.loadStatuses ?? loadAgentStatuses)(listed)
  const retired = listed.filter((id) => {
    const status = statuses.get(id)
    return status === undefined || status === 'terminated'
  })
  const now = deps.now ?? new Date()
  const retentionDays = (deps.getRetentionDays ?? getPrivateArchiveRetentionDays)()
  const cutoff = now.getTime() - retentionDays * DAY_MS
  const output = (
    await manager.exec(sandboxId, [
      'sh',
      '-c',
      ARCHIVE_SCRIPT,
      'sh',
      root,
      String(now.getTime()),
      String(cutoff),
      ...retired,
    ])
  ).toString()
  const match = output.match(/archived=(\d+) purged=(\d+)/)
  return {
    kept: listed.length - retired.length,
    archived: match ? Number(match[1]) : 0,
    purged: match ? Number(match[2]) : 0,
  }
}

const lastPrunedAt = new Map<string, number>()

/**
 * Best-effort, throttled prune after the consultant runtime was ensured.
 * Never throws: a failure is retried after the next interval.
 */
export async function maybePruneConsultantScratch(
  squadId: string,
  deps: ConsultantScratchPruneDeps & { nowMs?: number } = {}
): Promise<ConsultantScratchPruneResult | null> {
  const nowMs = deps.nowMs ?? Date.now()
  const last = lastPrunedAt.get(squadId)
  if (last !== undefined && nowMs - last < CONSULTANT_SCRATCH_PRUNE_INTERVAL_MS) return null
  lastPrunedAt.set(squadId, nowMs)
  try {
    const result = await pruneConsultantScratch(squadId, deps)
    if (result.archived || result.purged)
      log.info(
        `Consultant scratch for squad ${squadId}: archived ${result.archived}, purged ${result.purged} expired archive(s)`
      )
    return result
  } catch (error) {
    log.warn(`Consultant scratch prune failed for squad ${squadId}`, error)
    return null
  }
}

export function resetConsultantScratchPruneForTest(): void {
  lastPrunedAt.clear()
}
