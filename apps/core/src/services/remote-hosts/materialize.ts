import { randomUUID } from 'crypto'
import * as fs from 'fs'
import { join } from 'path'
import {
  KNOWN_HOSTS_BLOCK_BEGIN,
  KNOWN_HOSTS_BLOCK_END,
  knownHostsLineNamesHost,
  mergeManagedKnownHosts,
} from '@ficus/shared/known-hosts'
import { createLogger } from '../../lib/infra/logger'
import { getSecretStore } from '../secrets'
import { isHostRuntime } from '../sandbox/runtime'
import { ensureSquadSshDir, getSquadSshPath, REMOTE_HOST_KEY_PREFIX } from '../squad/ssh'
import {
  HOST_KEY_ALIAS_PREFIX,
  hostKeyAlias,
  hostKeyState,
  hostKeyUsable,
  listHostKeysForHosts,
  trustedHostKeys,
  type HostKeyState,
  type RemoteHostKey,
} from './host-keys'
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

export const MANAGED_BLOCK_BEGIN = '# >>> ficus remote hosts >>>'
export const MANAGED_BLOCK_END = '# <<< ficus remote hosts <<<'

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
 * How a granted host is rendered, decided by its host-key state
 * (`host-keys.ts`):
 * - `pinned`: a person trusted (or rollout adopted) its host key. The stanza
 *   checks the key strictly against the Core-managed known_hosts entries
 *   recorded under `HostKeyAlias ficus-remote.<name>`.
 * - `legacy`: registered before keys were pinned and still being adopted. Strict
 *   checking against whatever the box already trusts for the real hostname;
 *   never trust-on-first-use.
 * - `blocked`: no trusted key. The stanza refuses every connection with a
 *   message saying a person must confirm the host key; no key file is written.
 */
export type HostStanzaMode = 'pinned' | 'legacy' | 'blocked'

export interface RenderableHost {
  host: RemoteHost
  mode: HostStanzaMode
}

export function stanzaModeForState(state: HostKeyState): HostStanzaMode {
  if (state === 'adopting') return 'legacy'
  return hostKeyUsable(state) ? 'pinned' : 'blocked'
}

/** The refusal printed by a blocked host's stanza. Only charset-validated names reach it. */
export function blockedHostMessage(name: string): string {
  return `ficus: remote host ${name} is blocked until a person confirms its SSH host key (Settings > Remote hosts, or: ficus remote-hosts host-keys ${name})`
}

/**
 * Render the managed ssh_config block for a set of hosts. Pure and
 * side-effect free (no filesystem/secret-store access) so it can be tested
 * directly. Hosts that fail re-validation are skipped (with a warning) and
 * never reach the rendered output. Returns `''` when there are no valid
 * hosts to render (callers should omit the block entirely in that case).
 *
 * Every stanza sets `StrictHostKeyChecking yes` and `UpdateHostKeys no`: an
 * unknown or changed host key is refused and nothing is ever learned or
 * updated automatically (see {@link HostStanzaMode}). Usable stanzas also name
 * every source of trusted keys themselves (`UserKnownHostsFile`, and for pinned
 * hosts `GlobalKnownHostsFile /dev/null`, `VerifyHostKeyDNS no`,
 * `KnownHostsCommand none`), so no other setting can add a key.
 *
 * The block is placed FIRST in `config` (see {@link composeManagedConfig}) and
 * ends with a bare `Host *`: OpenSSH keeps the first value it obtains for each
 * option, so a squad's own `Host *` (for example `StrictHostKeyChecking no` or
 * `UserKnownHostsFile /dev/null`) can no longer override a managed host, while
 * the squad's settings still apply to every other host.
 *
 * `absoluteSshDir` selects how each stanza names the squad's ssh dir:
 *
 * - Omitted (k8s/docker/vm): `~/.ssh/...`, because those runtimes MOUNT (or
 *   push) the squad ssh dir at the sandbox user's `~/.ssh` (its `known_hosts`
 *   holds the managed block).
 * - Set (host runtime): the given ABSOLUTE directory. On host there is no
 *   mount — commands run as the operator, and `ssh -F <squadSshDir>/config`
 *   expands `~` to the OPERATOR's home, where the squad's `ficus_remote_<name>`
 *   key does not exist (and with `IdentitiesOnly yes` the alias hard-fails).
 *   `UserKnownHostsFile` names the squad's `known_hosts` for the same reason.
 *
 * The runtime is deliberately NOT read here — this function stays pure; the
 * callers below (which know the squadId) decide.
 */
export function renderManagedBlock(hosts: RenderableHost[], opts: { absoluteSshDir?: string } = {}): string {
  const valid = new Set(
    filterValidHosts(
      hosts.map((h) => h.host),
      'renderManagedBlock'
    )
  )
  const validHosts = hosts.filter((h) => valid.has(h.host))
  if (validHosts.length === 0) return ''

  const { absoluteSshDir } = opts
  const keyDir = absoluteSshDir ?? '~/.ssh'
  // Named explicitly in every runtime so a user `UserKnownHostsFile` can never
  // replace the file holding the pinned keys.
  const knownHostsLine = [`  UserKnownHostsFile ${keyDir}/known_hosts`]

  const entries = validHosts.map(({ host, mode }) => {
    const target = [
      `Host ${host.name}`,
      `  HostName ${host.sshHost}`,
      `  Port ${host.sshPort}`,
      `  User ${host.sshUser}`,
    ]
    if (mode === 'blocked') {
      return [
        ...target,
        `  StrictHostKeyChecking yes`,
        `  ProxyCommand sh -c 'echo "${blockedHostMessage(host.name)}" >&2; exit 1'`,
      ].join('\n')
    }
    return [
      ...target,
      `  IdentityFile ${keyDir}/${KEY_FILE_PREFIX}${host.name}`,
      `  IdentitiesOnly yes`,
      ...(mode === 'pinned' ? [`  HostKeyAlias ${hostKeyAlias(host.name)}`] : []),
      ...knownHostsLine,
      ...(mode === 'pinned'
        ? [
            `  GlobalKnownHostsFile /dev/null`,
            `  VerifyHostKeyDNS no`,
            // IgnoreUnknown keeps its first value and this block comes first, so
            // a narrower list here would replace the squad's own (for example
            // `IgnoreUnknown UseKeychain`) for managed hosts and break them.
            // `*` keeps those working and lets clients older than
            // KnownHostsCommand skip it. An option ssh does not know does
            // nothing, so ignoring unknown ones cannot relax checking.
            `  IgnoreUnknown *`,
            `  KnownHostsCommand none`,
          ]
        : []),
      `  StrictHostKeyChecking yes`,
      `  UpdateHostKeys no`,
    ].join('\n')
  })

  // The closing `Host *` returns the squad's own content (which follows the
  // block) to applying to every host, as it did before the block moved first.
  return [MANAGED_BLOCK_BEGIN, ...entries, 'Host *', MANAGED_BLOCK_END].join('\n')
}

/**
 * Render the known_hosts lines pinning each `pinned` host's trusted keys under
 * its HostKeyAlias. Pure.
 */
export function renderPinnedKnownHosts(hosts: Array<RenderableHost & { keys: RemoteHostKey[] }>): string[] {
  return hosts
    .filter((h) => h.mode === 'pinned' && NAME_RE.test(h.host.name))
    .flatMap((h) => trustedHostKeys(h.keys).map((k) => `${hostKeyAlias(h.host.name)} ${k.keyType} ${k.publicKey}`))
}

/**
 * The squad's Core known_hosts with the pinned remote-host keys merged into
 * the managed block (`@ficus/shared/known-hosts`). Remote-host aliases
 * (`ficus-remote.*`) are Core's namespace: any line outside the block that
 * names one — plainly, hashed, or through a wildcard such as `*` — would let a
 * second key satisfy the strict check, so it is dropped (with a warning) rather
 * than allowed to override or add to a pinned key. Every other line is kept.
 */
export function composeSquadKnownHosts(existing: string, pinLines: string[], aliases: string[]): string {
  const dropped: string[] = []
  let inBlock = false
  const kept = existing.split('\n').filter((line) => {
    // Lines inside the managed block are Core's own; the merge below re-renders them.
    const trimmed = line.trim()
    if (trimmed === KNOWN_HOSTS_BLOCK_BEGIN) inBlock = true
    if (trimmed === KNOWN_HOSTS_BLOCK_END) inBlock = false
    if (inBlock || trimmed === KNOWN_HOSTS_BLOCK_END) return true
    const fields = trimmed.split(/\s+/)
    const reservedName = (fields[0]?.startsWith('@') ? fields[1] : fields[0])
      ?.split(',')
      .some((p) => p.replace(/^!/, '').toLowerCase().startsWith(HOST_KEY_ALIAS_PREFIX))
    const namesAlias = aliases.some((alias) => knownHostsLineNamesHost(line, alias))
    if (reservedName || namesAlias) dropped.push(trimmed.slice(0, 80))
    return !(reservedName || namesAlias)
  })
  if (dropped.length) {
    log.warn(
      `dropped ${dropped.length} squad known_hosts line(s) naming a Ficus remote-host alias: ${dropped.join(' | ')}`
    )
  }
  return mergeManagedKnownHosts(kept.join('\n'), pinLines.join('\n')).content
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
 * managed block, placing the block BEFORE the user content (never inside it).
 * OpenSSH uses the first value obtained for each option, so the managed
 * host-key settings win over anything the squad's content sets for a managed
 * host (see {@link renderManagedBlock}); the block's closing `Host *` keeps the
 * squad's content applying to every other host. Shared by
 * `materializeSquadRemoteHosts` and `squad/ssh.ts`'s `setSshConfig`, so both
 * paths produce identical output.
 *
 * `userContent` is always preserved byte-exact: with an empty `block` it is
 * returned as is, otherwise it follows the block's own line, so
 * `stripManagedBlock(composeManagedConfig(u, b)) === u`.
 */
export function composeManagedConfig(userContent: string, block: string): string {
  if (!block) return userContent
  return `${block}\n${userContent}`
}

interface MaterializableHost extends RenderableHost {
  keys: RemoteHostKey[]
  /** Present for `pinned`/`legacy` hosts; blocked hosts get no key file. */
  privateKey: string | null
}

/**
 * A squad's granted hosts, filtered down to those eligible to be
 * materialized — valid (per `filterValidHosts`'s charset/directive-injection
 * checks) AND with a private key currently present in the secret store — each
 * with its stanza mode and host keys.
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
  const keysByHost = await listHostKeysForHosts(validHosts.map((h) => h.id))

  const materializable: MaterializableHost[] = []
  for (const host of validHosts) {
    // Never log or return the private key itself — only pass it straight
    // through to the key file.
    const privateKey = getSecretStore().get(host.sshKeyId)
    if (!privateKey) {
      log.warn(`skipping remote host ${host.id} (${host.name}) for squad ${squadId}: no private key in secret store`)
      continue
    }
    const keys = keysByHost.get(host.id) ?? []
    const mode = stanzaModeForState(hostKeyState(host, keys))
    materializable.push({ host, mode, keys, privateKey: mode === 'blocked' ? null : privateKey })
  }
  return materializable
}

/** The current managed block for a squad, recomputed live from the DB. */
export async function getManagedBlockForSquad(squadId: string): Promise<string> {
  return renderManagedBlock(await listMaterializableHosts(squadId), managedBlockOptions(squadId))
}

/** Write `content` atomically (same-directory temp file + rename) with `mode`. */
function writeFileAtomic(dir: string, name: string, content: string, mode: number): void {
  const tmpPath = join(dir, `.${name}.tmp-${randomUUID()}`)
  fs.writeFileSync(tmpPath, content, { mode })
  fs.chmodSync(tmpPath, mode)
  fs.renameSync(tmpPath, join(dir, name))
}

/**
 * Rewrite the squad's Core `known_hosts` with `userContent` plus the current
 * pinned remote-host keys (see {@link composeSquadKnownHosts}). Shared by
 * materialization and `squad/ssh.ts`'s known_hosts writers, so a user write can
 * neither drop nor forge a pinned key.
 */
export async function writeSquadKnownHosts(squadId: string, userContent?: string): Promise<void> {
  const materializable = await listMaterializableHosts(squadId)
  writeKnownHostsFile(squadId, ensureSquadSshDir(squadId), materializable, userContent)
}

function writeKnownHostsFile(
  squadId: string,
  sshPath: string,
  materializable: MaterializableHost[],
  userContent?: string
): void {
  const knownHostsPath = join(sshPath, 'known_hosts')
  const existing = userContent ?? (fs.existsSync(knownHostsPath) ? fs.readFileSync(knownHostsPath, 'utf-8') : '')
  const aliases = materializable.map((m) => hostKeyAlias(m.host.name))
  const next = composeSquadKnownHosts(existing, renderPinnedKnownHosts(materializable), aliases)
  if (userContent === undefined && next === existing) return
  if (userContent === undefined && !fs.existsSync(knownHostsPath) && next === '') return
  log.debug(`writing squad ${squadId} known_hosts (${aliases.length} remote-host alias(es))`)
  writeFileAtomic(sshPath, 'known_hosts', next, 0o644)
}

/**
 * Materialize a squad's granted remote hosts into its SSH dir: idempotent
 * and complete — writes a `ficus_remote_<name>` private key file (0600) per
 * usable granted host, removes any `ficus_remote_*` key file no longer
 * usable, rewrites the managed block in `config` while preserving all user
 * content outside the markers, and pins trusted host keys in `known_hosts`.
 * Call on every mutation that can affect a squad's grants or host keys
 * (create+grant, grant, revoke, host delete, trust/reject, adoption).
 */
export async function materializeSquadRemoteHosts(squadId: string): Promise<void> {
  const materializable = await listMaterializableHosts(squadId)

  const sshPath = ensureSquadSshDir(squadId)

  const materializedNames = new Set<string>()
  for (const { host, privateKey } of materializable) {
    if (privateKey === null) continue
    const keyPath = join(sshPath, `${KEY_FILE_PREFIX}${host.name}`)
    fs.writeFileSync(keyPath, privateKey, { mode: 0o600 })
    fs.chmodSync(keyPath, 0o600)
    materializedNames.add(host.name)
  }

  // Pin keys BEFORE the config names them: a stanza with HostKeyAlias and no
  // pinned entry would refuse (safe), but never the other way round.
  writeKnownHostsFile(squadId, sshPath, materializable)

  const block = renderManagedBlock(materializable, managedBlockOptions(squadId))

  const configPath = join(sshPath, 'config')
  const existingConfig = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf-8') : ''
  const userContent = stripManagedBlock(existingConfig)
  // Atomic write: `config` is a single composed document shared by every
  // host's stanza plus the squad's own user content, so a torn write here
  // corrupts everyone's SSH access, not just one host's.
  writeFileAtomic(sshPath, 'config', composeManagedConfig(userContent, block), 0o644)

  // Only now sweep: the config names just the key files written above, so no
  // removal (or failed removal) below can leave it pointing at a missing key.
  sweepStaleKeyFiles(squadId, sshPath, materializedNames)
}

/**
 * Remove key files for hosts no longer granted (or no longer valid). Entries that are not files or symlinks (a directory
 * someone created under a reserved name) are skipped, never recursed into. A
 * failed removal does not stop the sweep; the failures are reported together
 * after every other stale key is gone.
 */
function sweepStaleKeyFiles(squadId: string, sshPath: string, materializedNames: Set<string>): void {
  const failures: string[] = []
  for (const file of fs.readdirSync(sshPath)) {
    const stale = file.startsWith(KEY_FILE_PREFIX) && !materializedNames.has(file.slice(KEY_FILE_PREFIX.length))
    if (!stale) continue
    const path = join(sshPath, file)
    try {
      const entry = fs.lstatSync(path)
      if (!entry.isFile() && !entry.isSymbolicLink()) {
        log.warn(`remote-host key sweep for squad ${squadId}: skipping non-file entry ${file}`)
        continue
      }
      fs.unlinkSync(path)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue
      log.error(`remote-host key sweep for squad ${squadId}: could not remove ${file}`, err)
      failures.push(file)
    }
  }
  if (failures.length) {
    throw new Error(`remote-host key sweep for squad ${squadId} could not remove: ${failures.join(', ')}`)
  }
}
