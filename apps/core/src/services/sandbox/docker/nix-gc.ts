import type { AgentStatus } from '@ficus/shared'
import * as fs from 'fs'
import * as path from 'path'
import { eq } from 'drizzle-orm'
import { agents, db } from '../../../db'
import { getHomeDir } from '../../../lib/utils/home'
import { CONTAINER_PREFIX, reclaimAgentNixStore, resolveReclaimableNixStorePath } from './manager'

/**
 * Orphan Nix-store GC (#632 deferral).
 *
 * #632 reclaims a personal agent's per-sandbox Nix store at terminal lifecycle,
 * but pre-existing leaked stores (and any future misses) stay invisible. This
 * enumerates `~/.tau/nix/agent_<uuid>` stores, anti-joins the agent table, and
 * classifies each store so an operator can reclaim the dead ones.
 *
 * All the safety (strict `agent_<uuid>` regex, canonical-path guard, symlink /
 * running-container / unknown-state refusals, archive-free unlink) lives in the
 * two #632 primitives this reuses — `resolveReclaimableNixStorePath` as the
 * strict store filter and `reclaimAgentNixStore` as the reclaimer. Nothing here
 * touches `.base`, live rows, or running containers.
 */

/** `orphaned` = no agent row; `terminated` = final status; `live` = protected (including dormant). */
export type NixGcVerdict = 'orphaned' | 'terminated' | 'live'

export interface NixGcCandidate {
  /** The `agent_<uuid>` store dirname (== sandbox id). */
  sandboxId: string
  /** Reclaimable disk for this store, in bytes. */
  bytes: number
  verdict: NixGcVerdict
  /** Whether a sandbox container for this store is currently running. */
  running: boolean
}

export interface NixGcScan {
  candidates: NixGcCandidate[]
  /** Sum of `bytes` across reclaimable (orphaned/terminated + not-running) stores. */
  totalReclaimableBytes: number
}

export interface NixGcApplyResult extends NixGcScan {
  /** Sandbox ids whose store was reclaimed. */
  reclaimed: string[]
  /** Sandbox ids whose reclaim threw (best-effort — one failure never aborts the rest). */
  failed: string[]
}

/**
 * Seams for fakes. Defaults wire to the real filesystem, DB, docker, and #632
 * reclaimer; tests inject pure fakes.
 */
export interface NixGcDeps {
  /** Raw dirnames under `~/.tau/nix` (unfiltered — the strict regex is applied here). */
  listStoreEntries?: () => string[]
  /** Reclaimable bytes for a resolved store path. */
  storeSize?: (storePath: string) => number
  /** Agent row (or null) for an agent uuid — only lifecycle status is needed. */
  lookupAgent?: (agentId: string) => Promise<{ status: AgentStatus } | null>
  /** Whether a running container exists for this sandbox id. */
  isContainerRunning?: (sandboxId: string) => boolean
  /** Reclaim one store (defaults to the #632 primitive). */
  reclaim?: (sandboxId: string) => void
}

const AGENT_PREFIX = 'agent_'

function defaultListStoreEntries(): string[] {
  const nixRoot = path.join(getHomeDir(), 'nix')
  try {
    return fs.readdirSync(nixRoot)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

function defaultStoreSize(storePath: string): number {
  // `du -sk` reports real disk usage (dedupes the hardlinks/clones a per-sandbox
  // store shares with the base) — the honest "bytes you'd get back".
  const res = Bun.spawnSync(['du', '-sk', storePath], { stdout: 'pipe', stderr: 'pipe' })
  if (res.exitCode !== 0) return 0
  const kb = Number.parseInt(res.stdout.toString().trim().split(/\s+/)[0] ?? '0', 10)
  return Number.isFinite(kb) ? kb * 1024 : 0
}

async function defaultLookupAgent(agentId: string): Promise<{ status: AgentStatus } | null> {
  const [row] = await db.select({ status: agents.status }).from(agents).where(eq(agents.id, agentId)).limit(1)
  return row ?? null
}

function defaultIsContainerRunning(sandboxId: string): boolean {
  // Mirror reclaimAgentNixStore's container name so scan and reclaim agree on
  // the target. Report `true` ONLY on an explicit running state; absent or any
  // other state is `false` here — reclaimAgentNixStore stays the final guard
  // (it refuses running AND unknown-state containers), so a mis-report can never
  // let a running store be deleted.
  const containerName = `${CONTAINER_PREFIX}${sandboxId}`
  const inspect = Bun.spawnSync(['docker', 'inspect', '-f', '{{.State.Running}}', containerName], {
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (inspect.exitCode === 0) return inspect.stdout.toString().trim() === 'true'
  return false
}

/**
 * Enumerate + classify per-sandbox Nix stores. Non-`agent_<uuid>` entries
 * (`.base`, its `.tmp-*` siblings, foreign dirs, malformed names) fail the #632
 * strict resolver and are skipped before any DB/container/size work — never even
 * resolved. Reclaimable bytes count only orphaned/terminated stores with no
 * running container.
 */
export async function scanOrphanNixStores(deps: NixGcDeps = {}): Promise<NixGcScan> {
  const listStoreEntries = deps.listStoreEntries ?? defaultListStoreEntries
  const storeSize = deps.storeSize ?? defaultStoreSize
  const lookupAgent = deps.lookupAgent ?? defaultLookupAgent
  const isContainerRunning = deps.isContainerRunning ?? defaultIsContainerRunning

  const candidates: NixGcCandidate[] = []
  let totalReclaimableBytes = 0

  for (const name of listStoreEntries()) {
    let storePath: string
    try {
      // Reuse #632's strict `agent_<uuid>` regex + canonical-path guard as the
      // filter: anything else throws and is ignored.
      storePath = resolveReclaimableNixStorePath(name)
    } catch {
      continue
    }

    const agentId = name.slice(AGENT_PREFIX.length)
    const agent = await lookupAgent(agentId)
    const verdict: NixGcVerdict = !agent ? 'orphaned' : agent.status === 'terminated' ? 'terminated' : 'live'
    const running = isContainerRunning(name)
    const bytes = storeSize(storePath)

    candidates.push({ sandboxId: name, bytes, verdict, running })
    if (verdict !== 'live' && !running) totalReclaimableBytes += bytes
  }

  return { candidates, totalReclaimableBytes }
}

/**
 * Scan, then reclaim every eligible store (orphaned/terminated + not-running)
 * via the #632 primitive. Per-store best-effort: one failure is recorded and the
 * rest continue. Live rows and running containers are never touched.
 */
export async function applyNixGc(deps: NixGcDeps = {}): Promise<NixGcApplyResult> {
  const scan = await scanOrphanNixStores(deps)
  const reclaim = deps.reclaim ?? ((sandboxId: string) => reclaimAgentNixStore(sandboxId))

  const reclaimed: string[] = []
  const failed: string[] = []
  for (const candidate of scan.candidates) {
    if (candidate.verdict === 'live' || candidate.running) continue
    try {
      reclaim(candidate.sandboxId)
      reclaimed.push(candidate.sandboxId)
    } catch {
      failed.push(candidate.sandboxId)
    }
  }

  return { ...scan, reclaimed, failed }
}
