/**
 * Squad Bash Tool
 *
 * `squad_bash` execs into the SHARED warm `squad_<id>` sandbox instead of the
 * agent's own light sandbox. Phase 1b moved every agent into a private light
 * sandbox, so squad-mates no longer share a live runtime (processes, ports,
 * runtime-installed tools) — only the shared workspace files. `squad_bash`
 * restores shared-runtime collaboration by targeting the retained warm box.
 *
 * SECURITY (container/vm runtimes): the warm box sees no agent's private dir, so
 * squad_bash cannot read a squad-mate's isolated key store — keep it that way
 * (regression test in services/sandbox/ensure.squad-private-isolation.test.ts).
 * The HOST runtime has no isolation boundary at all: every squad agent runs as
 * the same unix user on one filesystem, so squad agents are mutually trusted
 * there by design.
 */

import type { AgentTool } from '@earendil-works/pi-agent-core'
import { getSandboxManager, isHostRuntime, isRemoteSandboxRuntime } from '../services/sandbox/factory'
import { resolveWorkspaceLayout } from '../services/sandbox/workspace-layout'
import type { SandboxedToolWithKey } from '../services/sandbox/types'
import { createDockerSandboxedBashTool } from './docker-sandbox'
import { createHostBashTool, HOST_BASH_DEFAULT_TIMEOUT_S, HOST_BASH_MAX_TIMEOUT_S } from './host-sandbox'
import { createK8sSandboxedBashTool, type SandboxToolsManager } from './sandbox-tools'
import { FOREGROUND_BASH_GUIDANCE } from '../lib/bash-contract'

export const SQUAD_BASH_TOOL_KEY = 'squad_bash'

function buildSquadBashDescription(workspaceMount: string): string {
  return (
    'Execute a bash command in the SHARED squad sandbox (the warm `squad_<id>` box), not your own light sandbox. ' +
    'This is the default for all repository/project commands: inspection, git, dependency and `devbox add` installs, Docker/Compose, tests, builds, servers, diagnostics, deployments, and cleanup. ' +
    'Reserve private `bash` for intentional personal/isolated scratch or sensitive material that must not enter shared state/logs. ' +
    `Both tools see the same shared \`${workspaceMount}\` files; only \`squad_bash\` shares the squad's processes, ports, installed tools, and caches. ` +
    `It cannot access private directories. Returns stdout and stderr. Optionally provide a timeout in seconds (default: 180s, max: 3600s). ${FOREGROUND_BASH_GUIDANCE}`
  )
}

/**
 * Build the `squad_bash` tool bound to a squad's warm box.
 *
 * @param warmSandboxId         The warm box id, `Squad.getSandboxId(squadId)`.
 * @param squadWorkspaceHostPath Host path of the squad workspace (Docker temp-script dir).
 *                              On the remote runtimes this is unused for routing; the
 *                              runtime-resolved `workspaceMount` is used as the warm box cwd
 *                              instead (`/workspace/<squadId>` on k8s, the squad box's
 *                              `~/workspace` on vm). The Docker branch is structurally
 *                              unchanged — its cwd comes from the warm box's own
 *                              `sandbox.workspaceMount` (set in A2).
 * @param ficusToken              Per-agent scoped token for `ficus` CLI auth inside the box.
 * @param agentId               The calling agent's id — used to register a recovery watch
 *                              (and wake this agent) when the warm box turns out to be down.
 *
 * NOTE: A tool-input-level `squad` argument (spec §3.3) is deferred — the SDK `bashSchema` is
 * fixed to `{ command, timeout? }` and §3.3 notes it adds no capability for single-squad agents.
 */
export function createSquadBashTool(
  warmSandboxId: string,
  squadWorkspaceHostPath: string,
  squadId: string,
  ficusToken?: string,
  agentId?: string,
  invocationOwnerId?: string,
  dependencies = {
    getSandboxManager,
    isRemoteSandboxRuntime,
    createHostBashTool,
    createK8sSandboxedBashTool,
    createDockerSandboxedBashTool,
  }
): SandboxedToolWithKey {
  const { workspaceMount } = resolveWorkspaceLayout({ squadId, sandboxId: warmSandboxId })

  let tool: AgentTool<any>
  // Host runtime runs squad_bash in the shared squad workspace directly (no warm
  // box). Remote runtimes (k8s + vm) reach the warm box over the manager's HTTP
  // client, so both use the client-based bash tool. Docker execs against the
  // host workspace path.
  if (isHostRuntime()) {
    tool = dependencies.createHostBashTool(workspaceMount, { ficusToken, squadId, agentId })
  } else if (dependencies.isRemoteSandboxRuntime()) {
    const manager = dependencies.getSandboxManager() as unknown as SandboxToolsManager
    tool = dependencies.createK8sSandboxedBashTool(workspaceMount, warmSandboxId, manager, ficusToken, {
      agentId,
      invocationOwnerId,
    })
  } else {
    tool = dependencies.createDockerSandboxedBashTool(
      squadWorkspaceHostPath,
      squadWorkspaceHostPath,
      warmSandboxId,
      ficusToken
    )
  }

  tool.name = SQUAD_BASH_TOOL_KEY
  tool.label = SQUAD_BASH_TOOL_KEY
  tool.description = isHostRuntime()
    ? `Execute a bash command in the SHARED squad workspace on this machine (\`${workspaceMount}\`), the default for all repository/project commands: inspection, git, dependencies, tests, builds, servers, diagnostics, deployments. Private \`bash\` runs in your private directory instead. Returns stdout and stderr. Optionally provide a timeout in seconds (default: ${HOST_BASH_DEFAULT_TIMEOUT_S}s, max: ${HOST_BASH_MAX_TIMEOUT_S}s). ${FOREGROUND_BASH_GUIDANCE}`
    : buildSquadBashDescription(workspaceMount)

  return { ...tool, key: SQUAD_BASH_TOOL_KEY }
}
