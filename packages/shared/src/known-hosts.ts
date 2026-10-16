/**
 * Merge Ficus-managed host keys into an existing OpenSSH `known_hosts` file
 * without disturbing entries Ficus did not put there.
 *
 * A squad's managed host keys (the `known_hosts` file in Core's squad ssh dir)
 * are delivered into a box's own `~/.ssh/known_hosts`, which agents and
 * operators also append to (`ssh-keyscan >> ~/.ssh/known_hosts`, OpenSSH's
 * own updates). Managed entries therefore live in ONE delimited block:
 *
 *   # >>> ficus managed known hosts >>>
 *   ...managed entries...
 *   # <<< ficus managed known hosts <<<
 *
 * Every line outside that block is kept byte-for-byte, in order. Each merge
 * strips the old block and appends a freshly rendered one, so repeated merges
 * are idempotent, a rotated managed key replaces only its managed line, and a
 * removed managed entry disappears from the block only.
 *
 * Trust is never weakened or silently changed:
 * - A managed entry whose host already has a user entry with the SAME key type
 *   but a DIFFERENT key is a conflict. It is left out of the block and
 *   reported; the user entry is never replaced. User entries are matched the
 *   way OpenSSH matches them: hashed (`|1|salt|hash`) patterns by recomputing
 *   the hash, wildcard (`*`, `?`) patterns by globbing, and a line whose
 *   negated pattern (`!host`) names the host does not apply to it.
 * - A managed entry the user already trusts with the same key is not
 *   duplicated.
 *
 * Resolving a conflict in Core's favour is a separate, explicit step
 * ({@link removeConflictingHostKeys}) that a person chooses; a merge never does it.
 *
 * Pure (no filesystem access) so Core (vm push) and the sandbox entrypoint
 * (k8s mirror) share exactly one implementation.
 */

import { createHash, createHmac } from 'node:crypto'

export const KNOWN_HOSTS_BLOCK_BEGIN = '# >>> ficus managed known hosts >>>'
export const KNOWN_HOSTS_BLOCK_END = '# <<< ficus managed known hosts <<<'

/** A managed entry that was not written because the user already pins a different key. */
export interface KnownHostsConflict {
  /** The managed host pattern (e.g. `example.com` or `[example.com]:2222`). */
  host: string
  keyType: string
  /** 1-based line number of the conflicting user entry in the existing file. */
  line: number
  /** The managed (Core) key blob that was left out. */
  key: string
  /** The conflicting user (box) key blob. */
  boxKey: string
  /** True when the user line names the host only through a wildcard pattern. */
  wildcard: boolean
}

export interface KnownHostsMergeResult {
  /** The merged file content. */
  content: string
  /** Whether `content` differs from the existing content. */
  changed: boolean
  conflicts: KnownHostsConflict[]
}

interface ParsedEntry {
  marker?: string
  hosts: string[]
  keyType: string
  key: string
}

/** OpenSSH public key algorithm names (`ssh-ed25519`, `ecdsa-sha2-nistp256`, `sk-ssh-ed25519@openssh.com`, ...). */
const KEY_TYPE = /^(ssh|ecdsa|sk)-[A-Za-z0-9@.-]+$/
const BASE64_KEY = /^[A-Za-z0-9+/]+={0,3}$/

/** Parse one known_hosts line into its fields; null for blanks, comments and malformed lines. */
function parseEntry(line: string): ParsedEntry | null {
  const trimmed = line.trim()
  if (!trimmed || trimmed.startsWith('#')) return null
  const fields = trimmed.split(/\s+/)
  const marker = fields[0].startsWith('@') ? fields.shift() : undefined
  if (fields.length < 3) return null
  const [hostField, keyType, key] = fields
  if (!KEY_TYPE.test(keyType) || !BASE64_KEY.test(key)) return null
  return { marker, hosts: hostField.split(','), keyType, key }
}

function isWildcard(pattern: string): boolean {
  return !pattern.startsWith('|1|') && /[*?]/.test(pattern)
}

function globMatches(pattern: string, host: string): boolean {
  const re = pattern
    .toLowerCase()
    .split('')
    .map((ch) => (ch === '*' ? '.*' : ch === '?' ? '.' : ch.replace(/[\\^$.|+()[\]{}]/g, '\\$&')))
    .join('')
  return new RegExp(`^${re}$`).test(host)
}

/** Whether a single (non-negated) known_hosts host pattern — plain, hashed or wildcard — names `host`. */
function patternNamesHost(pattern: string, host: string): boolean {
  if (pattern.startsWith('|1|')) {
    const [, , salt, hash] = pattern.split('|')
    if (!salt || !hash) return false
    try {
      return createHmac('sha1', Buffer.from(salt, 'base64')).update(host).digest('base64') === hash
    } catch {
      return false
    }
  }
  if (isWildcard(pattern)) return globMatches(pattern, host)
  return pattern.toLowerCase() === host
}

/**
 * How an entry's host patterns apply to `host`, the way OpenSSH evaluates a
 * comma-separated pattern list: any matching negated pattern excludes the line;
 * otherwise it applies when a positive pattern matches. `exact` means a plain or
 * hashed pattern named it; `wildcard` means only a wildcard pattern did.
 */
function hostMatch(entry: ParsedEntry, host: string): 'exact' | 'wildcard' | null {
  if (entry.hosts.some((p) => p.startsWith('!') && patternNamesHost(p.slice(1), host))) return null
  const positive = entry.hosts.filter((p) => p && !p.startsWith('!') && patternNamesHost(p, host))
  if (!positive.length) return null
  return positive.some((p) => !isWildcard(p)) ? 'exact' : 'wildcard'
}

/** Concrete hostnames a managed entry names (negations and wildcards are not concrete). */
function concreteHosts(entry: ParsedEntry): string[] {
  return entry.hosts.filter((host) => host && !host.startsWith('!') && !/[*?]/.test(host)).map((h) => h.toLowerCase())
}

interface NumberedLine {
  text: string
  line: number
}

/** Split `content` into user lines (block removed) and whether any marker was present. */
function stripManagedBlock(lines: string[]): { userLines: NumberedLine[]; hadMarkers: boolean } {
  const endIndex = (from: number) => lines.findIndex((l, i) => i > from && l.trim() === KNOWN_HOSTS_BLOCK_END)
  const userLines: NumberedLine[] = []
  let hadMarkers = false
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim()
    if (trimmed === KNOWN_HOSTS_BLOCK_BEGIN) {
      hadMarkers = true
      const end = endIndex(i)
      // An unterminated begin marker drops only the marker itself: losing a
      // stale managed entry to a conflict report is safe, deleting user lines is not.
      if (end !== -1) i = end
      continue
    }
    if (trimmed === KNOWN_HOSTS_BLOCK_END) {
      hadMarkers = true
      continue
    }
    userLines.push({ text: lines[i], line: i + 1 })
  }
  return { userLines, hadMarkers }
}

function splitLines(content: string): string[] {
  const lines = content.split('\n')
  if (lines.at(-1) === '') lines.pop()
  return lines
}

/**
 * The name OpenSSH records in known_hosts for a destination: `host` on port 22,
 * `[host]:port` otherwise. OpenSSH lowercases the hostname first.
 */
export function knownHostsName(host: string, port: number): string {
  const lower = host.toLowerCase()
  return port === 22 ? lower : `[${lower}]:${port}`
}

/** OpenSSH's SHA256 fingerprint of a base64 key blob (`SHA256:<unpadded base64>`). */
export function hostKeyFingerprint(key: string): string {
  return `SHA256:${createHash('sha256').update(Buffer.from(key, 'base64')).digest('base64').replace(/=+$/, '')}`
}

/**
 * Whether a known_hosts line applies to `host` the way OpenSSH matches it
 * (plain, hashed or wildcard patterns; a matching negation excludes the line).
 * Blank, comment and malformed lines never apply.
 */
export function knownHostsLineNamesHost(line: string, host: string): boolean {
  const entry = parseEntry(line)
  return entry !== null && hostMatch(entry, host.toLowerCase()) !== null
}

/** A host key a known_hosts file trusts for one name. */
export interface KnownHostKey {
  keyType: string
  /** Base64 key blob. */
  key: string
  /** 1-based line number in the file. */
  line: number
}

/**
 * The host keys `content` trusts for `name` (as produced by {@link knownHostsName})
 * through a plain or hashed pattern. Wildcard matches are left out: OpenSSH
 * never records one when it learns a key, so they are not evidence of a key
 * having been seen for this host. A line whose negated pattern names the host
 * does not apply, `@cert-authority` lines are not host keys, and a key also
 * listed `@revoked` for the host is left out.
 */
export function findKnownHostKeys(content: string, name: string): KnownHostKey[] {
  const target = name.toLowerCase()
  const found: KnownHostKey[] = []
  const revoked = new Set<string>()
  splitLines(content.replace(/\r\n/g, '\n')).forEach((text, index) => {
    const entry = parseEntry(text)
    if (!entry) return
    const match = hostMatch(entry, target)
    if (entry.marker === '@revoked' && match) revoked.add(`${entry.keyType} ${entry.key}`)
    else if (entry.marker === undefined && match === 'exact') {
      found.push({ keyType: entry.keyType, key: entry.key, line: index + 1 })
    }
  })
  return found.filter((k) => !revoked.has(`${k.keyType} ${k.key}`))
}

/**
 * Merge the managed entries in `managedSource` into `existing` (see module doc).
 * `managedSource` comments, blank lines, block markers and malformed lines are ignored.
 */
export function mergeManagedKnownHosts(existing: string, managedSource: string): KnownHostsMergeResult {
  const { userLines, hadMarkers } = stripManagedBlock(splitLines(existing))
  const userEntries = userLines
    .map(({ text, line }) => ({ entry: parseEntry(text), line }))
    .filter((u): u is { entry: ParsedEntry; line: number } => u.entry !== null && u.entry.marker === undefined)

  const conflicts: KnownHostsConflict[] = []
  const blockLines: string[] = []
  const seen = new Set<string>()
  for (const raw of splitLines(managedSource.replace(/\r\n/g, '\n'))) {
    const entry = parseEntry(raw)
    if (!entry) continue
    const normalized = [entry.marker, entry.hosts.join(','), entry.keyType, entry.key].filter(Boolean).join(' ')
    if (seen.has(normalized)) continue
    seen.add(normalized)

    if (entry.marker === undefined) {
      const hosts = concreteHosts(entry)
      const sameType = (host: string) =>
        userEntries
          .filter((u) => u.entry.keyType === entry.keyType)
          .map((u) => ({ ...u, match: hostMatch(u.entry, host) }))
          .filter((u) => u.match !== null)
      const entryConflicts = hosts.flatMap((host) =>
        sameType(host)
          .filter((u) => u.entry.key !== entry.key)
          .map((u) => ({
            host,
            keyType: entry.keyType,
            line: u.line,
            key: entry.key,
            boxKey: u.entry.key,
            wildcard: u.match === 'wildcard',
          }))
      )
      if (entryConflicts.length) {
        conflicts.push(...entryConflicts)
        continue
      }
      // Already trusted by the user with this exact key on every host: no duplicate.
      if (hosts.length && hosts.every((host) => sameType(host).length > 0)) continue
    }
    blockLines.push(normalized)
  }

  if (!blockLines.length && !hadMarkers) return { content: existing, changed: false, conflicts }

  const kept = userLines.map((u) => u.text)
  while (kept.length && kept.at(-1)!.trim() === '') kept.pop()
  const out = blockLines.length ? [...kept, KNOWN_HOSTS_BLOCK_BEGIN, ...blockLines, KNOWN_HOSTS_BLOCK_END] : kept
  const content = out.length ? `${out.join('\n')}\n` : ''
  return { content, changed: content !== existing, conflicts }
}

export interface RemoveConflictingResult {
  /** The edited content (identical to the input when nothing was removed). */
  content: string
  /** 1-based numbers of the lines that were edited or dropped. */
  editedLines: number[]
  /** 1-based numbers of conflicting lines that name the host only through a wildcard; never edited. */
  wildcardLines: number[]
}

/**
 * Resolve a conflict in Core's favour: drop `host`'s trust in every user (box)
 * line, outside the managed block, that pins a `keyType` key other than
 * `coreKey` through a plain or hashed pattern. Only `host` loses trust: a
 * comma-separated line that also names other hosts keeps them (the matching
 * pattern is removed from the list); a line left with no positive pattern is
 * dropped. Every other line, comments included, is kept byte-for-byte.
 *
 * A conflicting line that names the host only through a wildcard is NEVER
 * edited (it may cover hosts Ficus knows nothing about, and adding a negation
 * would silently narrow it). It is reported in `wildcardLines` and the caller
 * must refuse the resolution; with any wildcard line present nothing is edited.
 */
export function removeConflictingHostKeys(
  existing: string,
  host: string,
  keyType: string,
  coreKey: string
): RemoveConflictingResult {
  const target = host.toLowerCase()
  const lines = splitLines(existing)
  const userLineNumbers = new Set(stripManagedBlock(lines).userLines.map((u) => u.line))
  const editedLines: number[] = []
  const wildcardLines: number[] = []
  const out: string[] = []
  lines.forEach((text, index) => {
    const line = index + 1
    const entry = userLineNumbers.has(line) ? parseEntry(text) : null
    const match = entry && entry.marker === undefined && entry.keyType === keyType && entry.key !== coreKey
    const how = match ? hostMatch(entry, target) : null
    if (!entry || !how) {
      out.push(text)
      return
    }
    const remaining = entry.hosts.filter((p) => p.startsWith('!') || isWildcard(p) || !patternNamesHost(p, target))
    // Still naming the host once its plain/hashed patterns are gone: a wildcard covers it too.
    if (how === 'wildcard' || hostMatch({ ...entry, hosts: remaining }, target)) {
      wildcardLines.push(line)
      out.push(text)
      return
    }
    editedLines.push(line)
    if (!remaining.some((p) => p && !p.startsWith('!'))) return
    out.push(text.replace(/^(\s*)\S+/, `$1${remaining.join(',')}`))
  })
  if (wildcardLines.length || !editedLines.length) return { content: existing, editedLines: [], wildcardLines }
  const trailingNewline = existing.endsWith('\n')
  const content = out.length ? `${out.join('\n')}${trailingNewline ? '\n' : ''}` : ''
  return { content, editedLines, wildcardLines }
}
