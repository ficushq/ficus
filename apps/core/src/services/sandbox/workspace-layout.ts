import { join } from 'path'
import { WORKSPACE_MOUNT, MEMORY_MOUNT } from './types'
import { isHostRuntime, isVmRuntime } from './runtime'
import { getHomeDir } from '../../lib/utils/home'
import { getHostWorkspaceOverride } from './host/workspace-overrides'
import { boxHome } from '../machines/box-paths'

/**
 * The identifiers a workspace layout is derived from. Everything is
 * deterministic — no live sandbox or db row is consulted:
 *
 * - `squadId` scopes the agent to its squad's shared workspace + memory.
 * - `sandboxId` is the agent's OWN sandbox id (`agent_<id>`,
 *   `system_manager_<user>`, or `squad_<id>` for the warm box itself). The
 *   container runtimes ignore it (their mounts are fixed), but the vm runtime
 *   needs it to derive the box user's HOME — pass it whenever it is known.
 */
export interface WorkspaceLayoutContext {
  squadId?: string
  sandboxId?: string
}

/** An agent's sandbox-side path layout. Single source of truth for where
 *  the agent's working directory lives inside its sandbox. */
export interface WorkspaceLayout {
  /** Sandbox-side path of the agent's primary working directory (tool root). */
  workspaceMount: string
  /** Sandbox-side path of the squad memory tree (k8s/docker: `/memory[/<squadId>]`; vm: the squad box's `~/memory` replica). */
  memoryMount: string
  /** Default working directory for the agent session / sandbox exec. */
  cwd: string
  /** Per-agent private area (key custody + private scratch), inaccessible to other agents. */
  privateMount: string
}

/**
 * The fixed container layout used by the k8s and docker runtimes, where the
 * sandbox mounts `/workspace[/<squadId>]`, `/memory[/<squadId>]`, and
 * `/private` at those literal paths. Mount/pod-spec construction on those
 * runtimes calls this directly so it never depends on the process-wide
 * runtime env var.
 */
export function containerWorkspaceLayout(ctx: WorkspaceLayoutContext = {}): WorkspaceLayout {
  const { squadId } = ctx
  return {
    workspaceMount: squadId ? `${WORKSPACE_MOUNT}/${squadId}` : WORKSPACE_MOUNT,
    memoryMount: squadId ? `${MEMORY_MOUNT}/${squadId}` : MEMORY_MOUNT,
    cwd: squadId ? `${WORKSPACE_MOUNT}/${squadId}` : WORKSPACE_MOUNT,
    privateMount: '/private',
  }
}

/**
 * The vm ("box") runtime layout. Boxes are per-sandbox unix users on shared
 * VMs — there are NO `/workspace`, `/private`, or `/memory` mounts. Paths are
 * box-native ABSOLUTE homes, derivable offline because the box unix user is a
 * pure hash of the sandboxId (see machines/box-paths):
 *
 * - Squad-scoped: the shared workspace + memory replica live in the SQUAD
 *   box's home (`/home/<squadBoxUser>/workspace`, `/home/<squadBoxUser>/memory`
 *   — the replica tree file-sync pushes). The agent's private dir is its OWN
 *   box's `~/.private`.
 * - Solo (no squad): the agent's box has no shared workspace at all; its work
 *   root, cwd, and private dir are all its own `~/.private` (matching the vm
 *   manager's `boxWorkRoot(sandboxId, 'agent')`), and `memoryMount` is its own
 *   `~/memory`.
 * - Neither id known: the box home cannot be derived; falls back to the
 *   container literals (which the box sandbox-server rebases onto the box
 *   HOME for file ops — see packages/k8s-sandbox/src/paths.ts). Call sites
 *   should pass ids so agent-visible paths are box-native.
 */
export function vmWorkspaceLayout(ctx: WorkspaceLayoutContext = {}): WorkspaceLayout {
  const { squadId, sandboxId } = ctx
  if (squadId) {
    const squadHome = boxHome(`squad_${squadId}`)
    const workspaceMount = `${squadHome}/workspace`
    return {
      workspaceMount,
      memoryMount: `${squadHome}/memory`,
      cwd: workspaceMount,
      // Without the agent's own sandboxId the private dir of a squad-scoped
      // caller is not derivable; fall back to the squad box's own `.private`
      // (squad-box-scoped callers — squad_bash, monitors, deploys — only
      // consume workspaceMount/memoryMount, never privateMount).
      privateMount: `${boxHome(sandboxId ?? `squad_${squadId}`)}/.private`,
    }
  }
  if (sandboxId) {
    const home = boxHome(sandboxId)
    const privateMount = `${home}/.private`
    return {
      workspaceMount: privateMount,
      memoryMount: `${home}/memory`,
      cwd: privateMount,
      privateMount,
    }
  }
  return containerWorkspaceLayout(ctx)
}

/**
 * The host (no-sandbox) runtime layout: the core's OWN storage paths, i.e. the
 * exact host directories the docker runtime bind-mounts into containers. No
 * asset is copied anywhere — identity keys, attachments, memory, skills and
 * the squad workspace already live here.
 *
 * - Squad-scoped: workspace = the squad's override (squads.host_workspace_path,
 *   via the in-memory cache) or `<HOME_DIR>/workspaces/squads/<squadId>`;
 *   memory = `<HOME_DIR>/memory/<squadId>`; private = the agent's own
 *   `<HOME_DIR>/private/<sandboxId>` (squad box's when sandboxId is absent).
 * - Solo: work root, cwd and private are all `<HOME_DIR>/private/<sandboxId>`.
 * - Neither id: container literals (same rule as vm).
 *
 * Path strings are computed with `join` rather than the storage helpers so
 * this stays side-effect free (getSquadMemoryPath mkdirs); the layout tests
 * pin equality with those helpers.
 */
export function hostWorkspaceLayout(ctx: WorkspaceLayoutContext = {}): WorkspaceLayout {
  const { squadId, sandboxId } = ctx
  const home = getHomeDir()
  const privateFor = (id: string) => join(home, 'private', id)
  if (squadId) {
    const workspaceMount = getHostWorkspaceOverride(squadId) ?? join(home, 'workspaces', 'squads', squadId)
    return {
      workspaceMount,
      memoryMount: join(home, 'memory', squadId),
      cwd: workspaceMount,
      privateMount: privateFor(sandboxId ?? `squad_${squadId}`),
    }
  }
  if (sandboxId) {
    const privateMount = privateFor(sandboxId)
    return { workspaceMount: privateMount, memoryMount: join(home, 'memory'), cwd: privateMount, privateMount }
  }
  return containerWorkspaceLayout(ctx)
}

/**
 * Resolve an agent's workspace layout — the single source of truth for where an
 * agent's working directory, private dir, and memory live inside its sandbox,
 * dispatched on the ACTIVE runtime (FICUS_SANDBOX_RUNTIME):
 *
 * - k8s + docker (and unset): the fixed container mounts
 *   ({@link containerWorkspaceLayout}).
 * - vm: box-native absolute paths ({@link vmWorkspaceLayout}).
 * - host: the core's storage paths ({@link hostWorkspaceLayout}).
 *
 * Every consumer — tool cwd roots, prompts, and agent-visible text — reads this
 * result, so agents are never shown paths that do not exist in their sandbox.
 * Call sites that hold a sandbox manager can equivalently use the manager's
 * `getWorkspaceLayout(ctx)` (same underlying per-runtime functions).
 */
export function resolveWorkspaceLayout(ctx: WorkspaceLayoutContext = {}): WorkspaceLayout {
  if (isHostRuntime()) return hostWorkspaceLayout(ctx)
  return isVmRuntime() ? vmWorkspaceLayout(ctx) : containerWorkspaceLayout(ctx)
}

/**
 * Sandbox path of an agent's own working root — the single source of truth for
 * "where this agent's files live inside its box", on the active runtime.
 *
 * Squad members and the squad warm box work in the shared squad workspace
 * (`/workspace/<squadId>` on containers, the squad box's `~/workspace` on vm).
 * Solo (non-squad) agents have NO shared workspace at all; their working root
 * is their private dir. So the shared workspace exists only for squads, and
 * every agent consistently has a private dir.
 */
export function resolveContainerWorkRoot(ctx: WorkspaceLayoutContext = {}): string {
  const layout = resolveWorkspaceLayout(ctx)
  return ctx.squadId ? layout.workspaceMount : layout.privateMount
}

/** {@link resolveContainerWorkRoot}, pinned to the container runtimes' layout
 *  (used by the docker/k8s managers' mount construction, env-independent). */
export function containerWorkRoot(ctx: WorkspaceLayoutContext = {}): string {
  const layout = containerWorkspaceLayout(ctx)
  return ctx.squadId ? layout.workspaceMount : layout.privateMount
}
