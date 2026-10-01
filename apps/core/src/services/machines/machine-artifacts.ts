import { randomUUID } from 'node:crypto'
import type { Machine } from './queries'
import { stampArtifactVersion as stampArtifactVersionDefault } from './queries'
import { defaultSshRunner } from './ssh'
import type { SshRunner } from './ssh'

/**
 * Generic machine-artifact delivery.
 *
 * An "artifact" is a named, content-versioned set of files core builds locally
 * and pushes to every machine over SSH (the sandbox-server bundle, the Ficus
 * CLI, ...). {@link ensureArtifact} generalizes the server-bundle pipeline:
 * build → skip when the machine's recorded version for that artifact already
 * matches → stream each file via `sudo install` into a staging path and rename
 * it into place (see {@link buildSudoInstallCommand}) → stamp the machine row's
 * `artifact_versions[name]`. The stamp is written only after EVERY file pushed
 * successfully, so a partial push leaves the recorded version unchanged and the
 * next ensure re-pushes the whole artifact.
 *
 * Import discipline (cycle avoidance): artifact-definition modules (e.g.
 * server-bundle.ts) import {@link ensureArtifact} and the types from HERE, and
 * the registry module (`machine-artifacts-registry.ts`) imports both this
 * module and the definition modules. This module must therefore never import a
 * definition module or the registry.
 */

/** Artifact files are multi-MB single-file transfers over ssh (the server
 *  bundle alone is several MB) — same bound the server-bundle push used. */
export const ARTIFACT_PUSH_TIMEOUT_MS = 2 * 60_000

/** One file of an artifact, as pushed to the machine. */
export interface ArtifactFile {
  /** Absolute destination path on the machine (root-owned trees are fine —
   *  the push runs under sudo). */
  remotePath: string
  /** File content, streamed over the ssh connection's stdin. */
  bytes: Uint8Array
  /** Octal mode string (e.g. '0755') applied by `install -m`. */
  mode: string
}

/** A named, buildable, content-versioned set of files to keep present on
 *  every machine. */
export interface MachineArtifact {
  /** Key in `machines.artifact_versions` (e.g. 'server', 'cli'). Stable. */
  name: string
  /**
   * Produce the artifact's files plus a content-derived version (sha256 over
   * every file's bytes). Definition modules should memoize this per process
   * (see server-bundle's `memoizeBuild`) — ensureArtifact calls it on every
   * ensure, drift or not, because the version IS the drift check's input.
   */
  build: () => Promise<{ files: ArtifactFile[]; version: string }>
}

export interface EnsureArtifactDeps {
  runner?: SshRunner
  stampArtifactVersion?: (machineId: string, name: string, version: string) => Promise<void>
}

/** Suffix of the staging path an artifact file is written to before it is
 *  renamed into place. Lands in the SAME directory as the destination, which is
 *  what makes the rename atomic (a cross-filesystem `mv` would be a copy).
 *
 *  A per-push random token is appended, because the staging path must be UNIQUE
 *  PER ATTEMPT. `ensureArtifact` runs on every box ensure — the keepalive sweep
 *  warms every box on a machine at once — so N concurrent pushes of the same
 *  artifact to one host are routine. Sharing one fixed staging name made them
 *  collide: each `install` overwrote the shared path, the first `mv` consumed
 *  it, and every loser failed with
 *      mv: cannot stat '<path>.ficus-new': No such file or directory
 *  which surfaced to the operator as a failed agent execution (observed live).
 *  A unique name per attempt makes concurrent pushes independent; each still
 *  lands atomically, and last-writer-wins on the destination is harmless
 *  because every pusher is writing byte-identical content for the same version. */
const ARTIFACT_STAGING_SUFFIX = '.ficus-new'

function stagingPathFor(remotePath: string): string {
  return `${remotePath}${ARTIFACT_STAGING_SUFFIX}.${randomUUID().slice(0, 8)}`
}

/** Octal-mode guard + single-quote escaping, mirroring ssh.ts's
 *  buildPushFileCommand (which builds the non-sudo, non-`-D` variant). */
function buildSudoInstallCommand(file: ArtifactFile): string {
  if (!/^[0-7]{3,4}$/.test(file.mode)) {
    throw new Error(`invalid file mode for ${file.remotePath}: ${file.mode}`)
  }
  const quote = (path: string) => `'${path.replace(/'/g, `'\\''`)}'`
  const quotedPath = quote(file.remotePath)
  const stagingPath = stagingPathFor(file.remotePath)
  const quotedStaging = quote(stagingPath)
  // Staged then RENAMED, never installed over the destination directly.
  // `install /dev/stdin <path>` truncates and rewrites the file in place, and
  // bash reads a script INCREMENTALLY — so a re-push of box-provision.sh
  // (an artifact since it became a registry entry) landing while a provision or
  // teardown is mid-execution corrupts the run. `mv` within one directory is
  // rename(2): atomic, and it leaves the already-open inode intact for the
  // running interpreter to finish reading.
  //
  // -D creates missing parent directories (GNU coreutils; Ubuntu targets), a
  // no-op when they already exist — so artifacts landing in fresh dirs (e.g.
  // /opt/ficus/cli) need no separate mkdir step. The mode is applied to the
  // staging file and carried through the rename.
  // `|| (rm -f staging; false)` keeps a failed push from leaving its unique
  // staging file behind forever — with per-attempt names there is no later push
  // that would overwrite it, so the cleanup has to be part of the same command.
  return (
    `sudo install -D -m ${file.mode} /dev/stdin ${quotedStaging} && ` +
    `{ sudo mv -f ${quotedStaging} ${quotedPath} || { sudo rm -f ${quotedStaging}; false; }; }`
  )
}

/**
 * Ensure `machine` carries the current build of `artifact`. No-op when the
 * machine's recorded `artifact_versions[artifact.name]` already matches the
 * build's version; otherwise streams every file over SSH via
 * `sudo install -D` + rename and stamps the new version — only after ALL files
 * pushed, so a failed push leaves the recorded version unchanged (next ensure
 * retries every file; each file lands atomically, and a re-push of an
 * already-current file is harmless). A push that dies between the install and
 * the rename leaves a `.ficus-new` file beside the destination, which the next
 * successful push overwrites; the destination itself is never half-written.
 *
 * The stamp goes through {@link stampArtifactVersionDefault}'s in-DB jsonb
 * merge — never a read-modify-write of `machine.artifactVersions` — so
 * ensuring several artifacts against one stale in-memory machine snapshot can
 * never clobber a sibling artifact's just-written stamp.
 */
export async function ensureArtifact(
  machine: Machine,
  artifact: MachineArtifact,
  deps: EnsureArtifactDeps = {}
): Promise<void> {
  const runner = deps.runner ?? defaultSshRunner
  const stampArtifactVersion = deps.stampArtifactVersion ?? stampArtifactVersionDefault

  const { files, version } = await artifact.build()
  if (machine.artifactVersions?.[artifact.name] === version) return

  for (const file of files) {
    const command = buildSudoInstallCommand(file)
    const result = await runner.run(machine, command, { stdin: file.bytes, timeoutMs: ARTIFACT_PUSH_TIMEOUT_MS })
    if (result.exitCode !== 0) {
      throw new Error(
        `push artifact '${artifact.name}' file to ${file.remotePath} failed (exit ${result.exitCode}): ${result.stderr.trim()}`
      )
    }
  }

  await stampArtifactVersion(machine.id, artifact.name, version)
}
