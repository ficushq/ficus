import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import inlinedBootstrapScript from '../../../../../scripts/machine/bootstrap.sh' with { type: 'text' }
import inlinedBoxProvisionScript from '../../../../../scripts/machine/box-provision.sh' with { type: 'text' }
import { MONOREPO_ROOT } from '../../lib/paths'

/**
 * True when this core runs from a shipped, immutable release artifact: the
 * artifact tree carries `artifact.json` at its root (spec §4.1). A git checkout
 * never has one. This is the ONLY signal that turns prebuilt machine-file reads
 * on by default — a bare `machine/` dir in a dev checkout is deliberately
 * ignored so a local artifact-builder run can't change dev behavior.
 */
export function isArtifactDeployment(root: string = MONOREPO_ROOT): boolean {
  return existsSync(join(root, 'artifact.json'))
}

/**
 * The subset of the release manifest (scripts/artifact/lib/manifest.ts's
 * `CoreArtifactManifest`) that runtime code needs — the identity fields, not
 * the full `files` map. Kept as a local, minimal shape rather than importing
 * the builder's type: this module is a RUNTIME reader, the builder is a
 * dev/CI-only tool, and the two should be free to diverge on anything beyond
 * this shared subset.
 */
export interface ArtifactManifestSummary {
  commit?: string
  digest?: string
}

/**
 * Reads and parses `<root>/artifact.json`. Returns null on ANY failure — file
 * missing, unreadable, or not valid JSON — so callers (deployment-flavor's
 * source detection, usage-reporter's build-version report) can treat "can't
 * determine the manifest" as an honest unknown instead of a boot-time throw.
 * `commit`/`digest` are individually undefined (not a whole-function failure)
 * when present-but-non-string or simply absent from the parsed object — the
 * caller decides what an absent/invalid field means for its own purpose
 * (e.g. deployment-flavor requires a valid 40-hex commit to call this an
 * 'artifact' deployment at all).
 */
export function readArtifactManifest(root: string = MONOREPO_ROOT): ArtifactManifestSummary | null {
  try {
    const raw = readFileSync(join(root, 'artifact.json'), 'utf8')
    const parsed = JSON.parse(raw) as Record<string, unknown>
    return {
      commit: typeof parsed.commit === 'string' ? parsed.commit : undefined,
      digest: typeof parsed.digest === 'string' ? parsed.digest : undefined,
    }
  } catch {
    return null
  }
}

export interface PrebuiltReadOpts {
  /** Explicit prebuilt dir (tests / the artifact builder). When set, a missing
   *  file returns null (source-build fallback) regardless of artifact mode. */
  dir?: string
  /** Root for artifact.json detection + the default `<root>/machine` dir.
   *  Defaults to MONOREPO_ROOT; injectable for tests. */
  root?: string
}

/**
 * Read one prebuilt machine file (`server.js`, `librust_pty.so`, `ficus.js`,
 * `bootstrap.sh`, `box-provision.sh`).
 *
 * - Explicit `dir`: read `<dir>/<name>`; missing → null, empty → throw.
 * - No `dir`, artifact deployment: read `<root>/machine/<name>`; missing OR
 *   empty → throw (an artifact missing a prebuilt file is broken — falling
 *   back to a source build cannot work in a tree with no src/ and would write
 *   outside the release).
 * - No `dir`, git checkout: always null (source build).
 */
export function readPrebuiltMachineFile(name: string, opts: PrebuiltReadOpts = {}): Uint8Array | null {
  const root = opts.root ?? MONOREPO_ROOT
  if (opts.dir !== undefined) {
    const path = join(opts.dir, name)
    if (!existsSync(path)) return null
    return readGuarded(path)
  }
  if (!isArtifactDeployment(root)) return null
  const path = join(root, 'machine', name)
  if (!existsSync(path)) {
    throw new Error(
      `artifact deployment is missing prebuilt machine file ${path} — the core release artifact is incomplete`
    )
  }
  return readGuarded(path)
}

function readGuarded(path: string): Uint8Array {
  const bytes = readFileSync(path)
  if (bytes.length === 0) throw new Error(`prebuilt machine file ${path} is empty`)
  return new Uint8Array(bytes)
}

/** Text variant (bootstrap.sh / box-provision.sh are pushed as strings). */
export function readPrebuiltMachineText(name: string, opts: PrebuiltReadOpts = {}): string | null {
  const bytes = readPrebuiltMachineFile(name, opts)
  return bytes === null ? null : new TextDecoder().decode(bytes)
}

/**
 * The ONE source of truth for the two machine scripts. `bootstrapMachine` (the
 * pusher), `currentBootstrapVersion` (the boot-time drift reconciler's
 * yardstick) and `boxProvisionArtifact` (the steady-state pusher) all resolve
 * through here, so the stamped version, the reconciler target and the pushed
 * bytes can never disagree — two independent derivations of this hash is
 * exactly the bug (#1155 x #1163) this module exists to prevent.
 */
export function effectiveMachineScripts(opts: PrebuiltReadOpts = {}): {
  bootstrapScript: string
  boxProvisionScript: string
} {
  return {
    bootstrapScript: readPrebuiltMachineText('bootstrap.sh', opts) ?? inlinedBootstrapScript,
    boxProvisionScript: readPrebuiltMachineText('box-provision.sh', opts) ?? inlinedBoxProvisionScript,
  }
}
