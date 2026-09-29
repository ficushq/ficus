import { boxProvisionArtifact } from './box-provision-artifact'
import { cliArtifact } from './cli-bundle'
import { ensureArtifact } from './machine-artifacts'
import type { EnsureArtifactDeps, MachineArtifact } from './machine-artifacts'
import type { Machine } from './queries'
import { serverArtifact } from './server-bundle'

/**
 * The registry of artifacts every machine must carry, ensured in array order
 * by {@link ensureMachineArtifacts}.
 *
 * This lives in its own module — NOT in machine-artifacts.ts — because the
 * artifact-definition modules (server-bundle.ts, cli-bundle.ts) import
 * `ensureArtifact`/types from machine-artifacts.ts; the registry entries in
 * turn are imported FROM those definition modules, so housing the registry
 * next to `ensureArtifact` would create an import cycle. Here the graph stays
 * one-directional: definitions → machine-artifacts; registry → definitions.
 *
 * Registered: box-provision.sh, then the sandbox-server bundle, then the Ficus
 * CLI. box-provision.sh is FIRST deliberately — it is the script every per-box
 * operation shells out to, it is a few KB against the server bundle's several
 * MB, and each artifact is required (a failure aborts the rest of the pass), so
 * ordering it first means a machine gets a current box-provision.sh even on a
 * pass where the big bundle push fails. See box-provision-artifact.ts for why
 * bootstrap-only delivery was not enough.
 */
export const MACHINE_ARTIFACTS: MachineArtifact[] = [boxProvisionArtifact, serverArtifact, cliArtifact]

/**
 * Ensure the machine carries EVERY registered artifact, in registry order.
 * Each artifact is required: a failed ensure propagates immediately (later
 * artifacts are not attempted this pass — the caller's next ensure retries
 * all, and per-artifact version stamps make the retry skip completed ones).
 */
export async function ensureMachineArtifacts(machine: Machine, deps: EnsureArtifactDeps = {}): Promise<void> {
  for (const artifact of MACHINE_ARTIFACTS) {
    await ensureArtifact(machine, artifact, deps)
  }
}
