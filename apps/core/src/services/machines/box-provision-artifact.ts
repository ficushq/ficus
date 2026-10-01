import { createHash } from 'crypto'
import { effectiveMachineScripts, type PrebuiltReadOpts } from './machine-prebuilt'
import type { ArtifactFile, MachineArtifact } from './machine-artifacts'

/**
 * `box-provision.sh` as a machine artifact.
 *
 * ## Why it is an artifact and not only a bootstrap push
 * Every per-box operation shells out to this script on the machine (provision,
 * `--remove`, `--restore`, `--restore-stream`). It used to be delivered ONLY by
 * {@link bootstrapMachine} — i.e. at provisioning time or on an explicit
 * re-bootstrap — so adding a new MODE to the script left every machine already
 * in the fleet running the old copy. When box migration moved to a streamed
 * restore, that meant `--restore-stream` would be rejected by every existing
 * machine ("unknown argument"), failing every migration and every rebalance
 * until an operator re-bootstrapped the whole fleet by hand.
 *
 * Registering it here makes rollout automatic instead: `ensureMachineArtifacts`
 * is already run on a migration's DESTINATION machine BEFORE the streamed
 * restore (box-migrate step 7, ahead of step 8), and on every machine by the
 * ordinary ensure paths, so a machine gets the current script exactly when it
 * is about to need it.
 *
 * The script content is ALSO folded into `computeBootstrapVersion`, so a script
 * edit still shows up as bootstrap drift; the two are independent detectors of
 * the same change and neither replaces the other. The script is small and the
 * push is skipped whenever the machine's recorded version already matches, so
 * carrying both costs nothing on a converged fleet.
 *
 * ## Where the bytes come from
 * {@link effectiveMachineScripts} — the ONE prebuilt-preferring resolution
 * shared with bootstrap.ts. In a dev/source run it yields the copy inlined at
 * build time (Bun's `with { type: 'text' }`): a runtime filesystem read of
 * scripts/ would ENOENT in the shipped bundle (apps/core/dist), which never
 * carries scripts/. In a shipped core artifact it yields the release's own
 * prebuilt `machine/box-provision.sh`. Resolving here rather than at module load
 * is what keeps this pusher, the bootstrap push and the bootstrap-version stamp
 * on the same bytes — a second, independent derivation would let this artifact
 * overwrite the release's script with the bundle's inlined copy on every ensure.
 */

/** Where box-provision.sh lands on every machine. The dir is created by
 *  bootstrap.sh's make_dirs; `ensureArtifact`'s `install -D` also creates it.
 *  Single source of truth for the push side (bootstrap.ts imports it). */
export const BOX_PROVISION_REMOTE_PATH = '/opt/ficus/bin/box-provision.sh'

/**
 * Build the artifact with an injectable prebuilt source (test seam; the registry
 * entry calls it with no opts). Pure content hash of the effective script: an
 * edited script re-pushes to every machine, an unchanged one is a no-op. No
 * build step, nothing wall-clock — so unlike the CLI bundle there is no re-push
 * churn to guard against.
 *
 * Deliberately NOT memoized (unlike server-bundle's `memoizeBuild`): reading the
 * effective script on every build is the whole point — a cached copy would pin
 * this process to the bytes present at the first ensure and miss a script the
 * deployment swapped underneath it, and the read is one small file.
 */
export async function buildBoxProvisionArtifact(
  opts: PrebuiltReadOpts = {}
): Promise<{ files: ArtifactFile[]; version: string }> {
  const { boxProvisionScript } = effectiveMachineScripts(opts)
  return {
    files: [
      {
        remotePath: BOX_PROVISION_REMOTE_PATH,
        bytes: new TextEncoder().encode(boxProvisionScript),
        mode: '0755',
      },
    ],
    version: createHash('sha256').update(boxProvisionScript).digest('hex'),
  }
}

export const boxProvisionArtifact: MachineArtifact = {
  name: 'box-provision',
  build: () => buildBoxProvisionArtifact(),
}
