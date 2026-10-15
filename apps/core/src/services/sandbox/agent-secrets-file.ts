/**
 * Where an agent's per-agent secrets file lives — the path helpers only, with
 * no database access, so the asset manifest, the bash tools, the prompt and
 * private-dir cleanup can share them without import cycles. The exposure model
 * and the writer live in services/agent/secrets.ts.
 *
 * The file is `<private dir>/.ficus/agent-secrets.env` (mode 0600) on every
 * isolated runtime:
 *   - core host:   `<HOME_DIR>/private/agent_<id>/.ficus/agent-secrets.env`
 *                  (the materializer output; docker and k8s mount this dir as
 *                  the sandbox's `/private`, vm pushes it to the box)
 *   - docker/k8s:  `/private/.ficus/agent-secrets.env`
 *   - vm box:      `~/.private/.ficus/agent-secrets.env` of the agent's own box user
 *
 * The name and location are fixed and part of the contract: other surfaces that
 * show an agent's private dir (file browsers, terminals) hide or mask this file.
 */

import { join } from 'path'
import { getHomeDir } from '../../lib/utils/home'
import { WORKSPACE_DOT_DIR, workspaceDotPath } from '../workspace/dot-dir'
import { resolveWorkspaceLayout } from './workspace-layout'

/** File name of the per-agent secrets file inside the private dir's `.ficus`. */
export const AGENT_SECRETS_FILE_NAME = 'agent-secrets.env'

/** Path of the secrets file relative to the agent's private dir. */
export const AGENT_SECRETS_RELATIVE_PATH = `${WORKSPACE_DOT_DIR}/${AGENT_SECRETS_FILE_NAME}`

const AGENT_SANDBOX_PREFIX = 'agent_'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * The agent id that personally owns `sandboxId`, or null for shared sandboxes
 * (`squad_`, `system_manager_`, consultant runtimes) and anything that is not
 * `agent_<uuid>`. Subagents run in their root agent's `agent_<rootId>` sandbox,
 * so this is the ROOT agent for them.
 */
export function agentIdFromAgentSandboxId(sandboxId: string): string | null {
  if (!sandboxId.startsWith(AGENT_SANDBOX_PREFIX)) return null
  const agentId = sandboxId.slice(AGENT_SANDBOX_PREFIX.length)
  return UUID.test(agentId) ? agentId : null
}

/** Core-host path the materializer writes for `sandboxId`. */
export function agentSecretsHostPath(sandboxId: string): string {
  return workspaceDotPath(join(getHomeDir(), 'private', sandboxId), AGENT_SECRETS_FILE_NAME)
}

/** Sandbox-side path of the file, on the active runtime's layout. */
export function agentSecretsSandboxPath(sandboxId: string): string {
  return `${resolveWorkspaceLayout({ sandboxId }).privateMount}/${AGENT_SECRETS_RELATIVE_PATH}`
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`
}

/**
 * Prefix an agent's own bash command so the per-agent secrets file is sourced
 * into THAT command's environment only (nothing long-lived: each command reads
 * the file afresh, so a revoked key is gone from the next command). The prefix
 * carries the path, never a value, and leaves `$?` at 0 when the file is absent.
 */
export function withAgentSecretsSourced(command: string, secretsPath: string): string {
  const path = shellQuote(secretsPath)
  return `if [ -r ${path} ]; then set -a; . ${path}; set +a; fi\n${command}`
}
