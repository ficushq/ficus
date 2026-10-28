import { boxProvisionLockArgs } from './box-host-lock'
import { boxUnixUser } from './box-paths'
import type { Machine } from './queries'
import { defaultSshRunner, type SshRunner } from './ssh'
import { BOX_PROVISION_REMOTE_PATH } from './box-provision-artifact'

/** Publish only the public default toolchain, before its dedicated prewarmer is removed.
 * Never call this with an ordinary box: its cache can contain private sources.
 * Publication only appends verified objects; it never garbage-collects shared roots.
 */
export async function publishPrewarmedNixCache(
  machine: Machine,
  sandboxId: string,
  runner: SshRunner = defaultSshRunner
): Promise<void> {
  if (!/^devbox-prewarm-(squad|agent)-[a-zA-Z0-9-]+$/.test(sandboxId)) {
    throw new Error('Only a dedicated devbox prewarmer can publish the shared Nix cache')
  }
  const result = await runner.run(
    machine,
    `sudo bash ${BOX_PROVISION_REMOTE_PATH} --publish-nix-cache --sandbox-id '${sandboxId}' --unix-user '${boxUnixUser(sandboxId)}' ${boxProvisionLockArgs(180_000)}`,
    { timeoutMs: 180_000 }
  )
  if (result.exitCode !== 0) throw new Error(`Nix cache publication failed: ${result.stderr.trim()}`)
}
