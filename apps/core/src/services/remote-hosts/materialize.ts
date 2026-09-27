import { randomUUID } from 'crypto'
import * as fs from 'fs'
import { join } from 'path'
import { createLogger } from '../../lib/infra/logger'
import { getSecretStore } from '../secrets'
import { isHostRuntime } from '../sandbox/runtime'
import { ensureSquadSshDir, getSquadSshPath, LEGACY_REMOTE_HOST_KEY_PREFIX, REMOTE_HOST_KEY_PREFIX } from '../squad/ssh'
import { listHostsGrantedToSquad, type RemoteHost } from './queries'

/**
 * Materializes a squad's granted remote hosts into its existing SSH dir
 * (`apps/core/src/services/squad/ssh.ts`): one `ficus_remote_<name>` private
 * key file per host, plus a managed block in `config` naming each host as an
 * ssh alias. See docs/history/superpowers/specs/2026-07-14-remote-hosts-design.md
 * § Materialization + § Security.
 *
 * `squad/ssh.ts`'s `setSshConfig` needs the current managed block to
 * re-append it after a user overwrites `config`. Importing this module from
 * `squad/ssh.ts` at the top level would create a hard cycle (this module
 * imports `ensureSquadSshDir` from `squad/ssh.ts`), so
 * `setSshConfig` reaches `getManagedBlockForSquad` via a lazy
 * `await import(...)` inside the function body instead of a static import.
 */

const log = createLogger('remote-hosts-materialize')

export const MANAGED_BLOCK_BEGIN = '# >>> tau remote hosts >>>'
export const MANAGED_BLOCK_END = '# <<< tau remote hosts <<<'

// `KEY_FILE_PREFIX` is exported from `squad/ssh.ts` (as `REMOTE_HOST_KEY_PREFIX`)
// rather than defined here, so `validateKeyName` there can reserve the same
// prefix against colliding uploads — see that module's doc comment.
const KEY_FILE_PREFIX = REMOTE_HOST_KEY_PREFIX

// Mirrors `remote_hosts.name`'s intended constraint (Task 1's design). Not
// all DB rows are guaranteed to satisfy this (the DB column has no CHECK
// constraint; only application-level validation enforces it), so it is
// re-checked here as a directive-injection guard before any value is
// interpolated into `config` or used as a filename.
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/

function isSingleLineNonEmpty(value: string): boolean {
  return value.length > 0 && !/\s/.test(value)
}

/**
 * Re-validate a host's name/sshHost/sshUser before it is rendered into the
 * squad's ssh_config or used to derive a key filename. Returns a
 * human-readable reason when invalid, or `null` when the host is safe to
 * materialize.
 */
function invalidHostReason(host: RemoteHost): string | null {
  if (!NAME_RE.test(host.name)) return `name "${host.name}" fails charset ^[a-z0-9][a-z0-9-]{0,62}$`
  if (!isSingleLineNonEmpty(host.sshHost)) return `sshHost is empty or contains whitespace/newlines`
  if (!isSingleLineNonEmpty(host.sshUser)) return `sshUser is empty or contains whitespace/newlines`
  return null
}

/** Filter out hosts that fail re-validation, warning for each one skipped. */
function filterValidHosts(hosts: RemoteHost[], context: string): RemoteHost[] {
  const valid: RemoteHost[] = []
  for (const host of hosts) {
    const reason = invalidHostReason(host)
    if (reason) {
      log.warn(`skipping remote host ${host.id} (${context}): ${reason}`)
      continue
    }
    valid.push(host)
  }
  return valid
}

/**
 * Render the managed ssh_config block for a set of hosts. Pure and
 * side-effect free (no filesystem/secret-store access) so it can be tested
 * directly. Hosts that fail re-validation are skipped (with a warning) and
 * never reach the rendered output. Returns `''` when there are no valid
 * hosts to render (callers should omit the block entirely in that case).
 *
 * `absoluteSshDir` selects how each stanza names the squad's ssh dir:
 *
 * - Omitted (k8s/docker/vm): `~/.ssh/...`, because those runtimes MOUNT the
 *   squad ssh dir at the sandbox user's `~/.ssh`, and `known_hosts` there is
 *   picked up by ssh's own default.
 * - Set (host runtime): the given ABSOLUTE directory. On host there is no
 *   mount — commands run as the operator, and `ssh -F <squadSshDir>/config`
 *   expands `~` to the OPERATOR's home, where the squad's `ficus_remote_<name>`
 *   key does not exist (and with `IdentitiesOnly yes` the alias hard-fails).
 *   `UserKnownHostsFile` is pinned for the same reason: otherwise the squad's
 *   `known_hosts` is ignored and host keys land in the operator's own file.
 *
 * The runtime is deliberately NOT read here — this function stays pure; the
 * callers below (which know the squadId) decide.
 */
export function renderManagedBlock(hosts: RemoteHost[], opts: { absoluteSshDir?: string } = {}): string {
  const validHosts = filterValidHosts(hosts, 'renderManagedBlock')
  if (validHosts.length === 0) return ''

  const { absoluteSshDir } = opts
  const keyDir = absoluteSshDir ?? '~/.ssh'

  const entries = validHosts.map((host) =>
    [
      `Host ${host.name}`,
      `  HostName ${host.sshHost}`,
      `  Port ${host.sshPort}`,
      `  User ${host.sshUser}`,
      `  IdentityFile ${keyDir}/${KEY_FILE_PREFIX}${host.name}`,
      `  IdentitiesOnly yes`,
      ...(absoluteSshDir ? [`  UserKnownHostsFile ${absoluteSshDir}/known_hosts`] : []),
      `  StrictHostKeyChecking accept-new`,
    ].join('\n')
  )

  return [MANAGED_BLOCK_BEGIN, ...entries, MANAGED_BLOCK_END].join('\n')
}

/**
 * The `renderManagedBlock` options for a squad on the ACTIVE runtime — the one
 * place the runtime is consulted, so both managed-block producers
 * (`materializeSquadRemoteHosts` and `getManagedBlockForSquad`) render
 * identically and a `setSshConfig` re-append can never downgrade a host-runtime
 * block back to `~/.ssh`.
 */
function managedBlockOptions(squadId: string): { absoluteSshDir?: string } {
  return isHostRuntime() ? { absoluteSshDir: getSquadSshPath(squadId) } : {}
}

/**
 * Strip any managed block(s) from an ssh_config's content, leaving
 * everything outside the `MANAGED_BLOCK_BEGIN`/`END` markers untouched. Used
 * both to recompute "user content" before rewriting the block during
 * materialization, and by `setSshConfig` to reject a forged block a caller
 * might try to smuggle into user-supplied config content.
 *
 * Edge semantics (both err toward stripping too much rather than too little,
 * since this function's output becomes the base user content that the
 * *current* managed block is always re-appended onto — over-stripping loses
 * at most a stray marker line, under-stripping could leak a stale/forged
 * block through):
 * - An unclosed BEGIN (a `MANAGED_BLOCK_BEGIN` line with no matching END
 *   afterward) strips from that line to end-of-file — everything past the
 *   BEGIN is treated as inside the block, including a trailing lone BEGIN
 *   with nothing after it.
 * - A lone END (a `MANAGED_BLOCK_END` line with no preceding BEGIN, or one
 *   already closed) is itself dropped — matching `inBlock` back to `false`
 *   is a no-op, but the marker line is still consumed by the `continue`
 *   before it reaches `result`.
 *
 * When no marker line is present at all, `config` is returned byte-exact —
 * not even re-joined — so a document with no managed block round-trips
 * through this function with zero mutation, including any blank-line runs
 * the user typed intentionally.
 *
 * When a block *is* removed, at most one redundant blank line is dropped
 * right at the seam it left behind (where a blank line that used to precede
 * the block and a blank line that used to follow it become newly adjacent),
 * so repeated strip/rewrite cycles don't accumulate blank lines there. This
 * is scoped to exactly that seam — a blank-line run anywhere else in the
 * document, even one of 3+ lines, is untouched, because it was never made
 * adjacent to anything by the removal.
 */
export function stripManagedBlock(config: string): string {
  const lines = config.split('\n')
  const result: string[] = []
  let inBlock = false
  let droppedAny = false
  // True while we're inside (or have just finished) a contiguous run of
  // dropped lines — used to detect the single seam line immediately after
  // such a run, the only place blank-line collapsing may apply.
  let dropping = false

  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed === MANAGED_BLOCK_BEGIN) {
      inBlock = true
      droppedAny = true
      dropping = true
      continue
    }
    if (trimmed === MANAGED_BLOCK_END) {
      inBlock = false
      droppedAny = true
      dropping = true
      continue
    }
    if (inBlock) {
      dropping = true
      continue
    }
    if (dropping) {
      // First kept line right after a drop-run: if it's blank and the line
      // already at the tail of `result` is also blank, the removal just
      // made two independent blank lines adjacent — drop this redundant one
      // rather than let it accumulate. Only ever removes at most one line,
      // and only immediately at this seam.
      if (trimmed === '' && result.length > 0 && result[result.length - 1] === '') {
        dropping = false
        continue
      }
      dropping = false
    }
    result.push(line)
  }

  if (!droppedAny) return config
  return result.join('\n')
}

/**
 * Combine a squad's user-authored ssh_config content with the current
 * managed block, appending the block after the user content (never inside
 * or above it). Shared by `materializeSquadRemoteHosts` (rewriting the block
 * in place) and `squad/ssh.ts`'s `setSshConfig` (re-appending the block
 * after a user overwrite), so both paths produce identically-formatted
 * output.
 *
 * When `block` is empty (no eligible hosts), `userContent` is returned
 * byte-exact — no trimming, no appended newline — so a squad with no
 * remote-host grants gets an exact write/read round-trip of its user
 * config. When `block` is non-empty, `userContent` is still preserved
 * exactly as given; the block is appended after a single newline boundary
 * (reusing `userContent`'s own trailing newline if it already ends with
 * one), so the block's presence is the only difference from the
 * empty-block output.
 */
export function composeManagedConfig(userContent: string, block: string): string {
  if (!block) return userContent
  if (!userContent) return `${block}\n`
  return userContent.endsWith('\n') ? `${userContent}${block}\n` : `${userContent}\n${block}\n`
}

interface MaterializableHost {
  host: RemoteHost
  privateKey: string
}

/**
 * A squad's granted hosts, filtered down to those eligible to be
 * materialized: valid (per `filterValidHosts`'s charset/directive-injection
 * checks) AND with a private key currently present in the secret store.
 *
 * Both managed-block producers — `materializeSquadRemoteHosts` (writes key
 * files + rewrites `config`) and `getManagedBlockForSquad` (recomputes the
 * block on demand for `squad/ssh.ts`'s `setSshConfig` re-append) — call this
 * so they apply identical eligibility. A host whose secret is missing must
 * never appear in either's output: if `getManagedBlockForSquad` rendered a
 * `Host` stanza for it while `materializeSquadRemoteHosts` skipped writing
 * its key file, a later `setSshConfig` call would re-inject an alias
 * pointing at a non-existent `~/.ssh/ficus_remote_<name>` file, which (with
 * `IdentitiesOnly yes`) hard-fails that alias.
 */
async function listMaterializableHosts(squadId: string): Promise<MaterializableHost[]> {
  const grantedHosts = await listHostsGrantedToSquad(squadId)
  const validHosts = filterValidHosts(grantedHosts, `materializeSquadRemoteHosts squad=${squadId}`)

  const materializable: MaterializableHost[] = []
  for (const host of validHosts) {
    // Never log or return the private key itself — only pass it straight
    // through to the key file.
    const privateKey = getSecretStore().get(host.sshKeyId)
    if (!privateKey) {
      log.warn(`skipping remote host ${host.id} (${host.name}) for squad ${squadId}: no private key in secret store`)
      continue
    }
    materializable.push({ host, privateKey })
  }
  return materializable
}

/** The current managed block for a squad, recomputed live from the DB. */
export async function getManagedBlockForSquad(squadId: string): Promise<string> {
  const materializable = await listMaterializableHosts(squadId)
  return renderManagedBlock(
    materializable.map((m) => m.host),
    managedBlockOptions(squadId)
  )
}

/**
 * Materialize a squad's granted remote hosts into its SSH dir: idempotent
 * and complete — writes a `ficus_remote_<name>` private key file (0600) per
 * granted host, removes any `ficus_remote_*` key file no longer granted, and
 * rewrites the managed block in `config` while preserving all user content
 * outside the markers. Call on every mutation that can affect a squad's
 * grants (create+grant, grant, revoke, host delete).
 */
export async function materializeSquadRemoteHosts(squadId: string): Promise<void> {
  const materializable = await listMaterializableHosts(squadId)

  const sshPath = ensureSquadSshDir(squadId)

  const materializedNames = new Set<string>()
  for (const { host, privateKey } of materializable) {
    const keyPath = join(sshPath, `${KEY_FILE_PREFIX}${host.name}`)
    fs.writeFileSync(keyPath, privateKey, { mode: 0o600 })
    fs.chmodSync(keyPath, 0o600)
    materializedNames.add(host.name)
  }

  // Remove stale key files for hosts no longer granted (or no longer valid),
  // and every key file written under the pre-rename prefix (K2): the current
  // grants were just re-written under KEY_FILE_PREFIX above.
  const existingFiles = fs.existsSync(sshPath) ? fs.readdirSync(sshPath) : []
  for (const file of existingFiles) {
    if (file.startsWith(LEGACY_REMOTE_HOST_KEY_PREFIX)) {
      fs.unlinkSync(join(sshPath, file))
      continue
    }
    if (!file.startsWith(KEY_FILE_PREFIX)) continue
    const name = file.slice(KEY_FILE_PREFIX.length)
    if (!materializedNames.has(name)) {
      fs.unlinkSync(join(sshPath, file))
    }
  }

  const block = renderManagedBlock(
    materializable.map((m) => m.host),
    managedBlockOptions(squadId)
  )

  const configPath = join(sshPath, 'config')
  const existingConfig = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf-8') : ''
  const userContent = stripManagedBlock(existingConfig)
  // Atomic write: write to a scratch file in the same directory (so the rename
  // is same-filesystem, hence atomic) then rename over `config`, so a crash or
  // concurrent read mid-write never observes a half-written config — unlike the
  // per-host key files above, `config` is a single composed document shared by
  // every host's stanza plus the squad's own user content, so a torn write here
  // corrupts everyone's SSH access, not just one host's.
  const tmpConfigPath = join(sshPath, `.config.tmp-${randomUUID()}`)
  fs.writeFileSync(tmpConfigPath, composeManagedConfig(userContent, block), { mode: 0o644 })
  fs.renameSync(tmpConfigPath, configPath)
}
