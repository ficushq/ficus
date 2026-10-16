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
 *   reported; the user entry is never replaced. Hashed (`|1|salt|hash`) user
 *   entries are matched by recomputing the hash, so they are protected too.
 * - A managed entry the user already trusts with the same key is not
 *   duplicated.
 *
 * Pure (no filesystem access) so Core (vm push) and the sandbox entrypoint
 * (k8s mirror) share exactly one implementation.
 */

import { createHmac } from 'node:crypto'

export const KNOWN_HOSTS_BLOCK_BEGIN = '# >>> ficus managed known hosts >>>'
export const KNOWN_HOSTS_BLOCK_END = '# <<< ficus managed known hosts <<<'

/** A managed entry that was not written because the user already pins a different key. */
export interface KnownHostsConflict {
  /** The managed host pattern (e.g. `example.com` or `[example.com]:2222`). */
  host: string
  keyType: string
  /** 1-based line number of the conflicting user entry in the existing file. */
  line: number
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

/** Whether a known_hosts host pattern (plain or hashed) names `host`. */
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
  return pattern.toLowerCase() === host
}

/** Concrete hostnames a managed entry names (negations and wildcards are not concrete). */
function concreteHosts(entry: ParsedEntry): string[] {
  return entry.hosts.filter((host) => host && !host.startsWith('!') && !/[*?]/.test(host)).map((h) => h.toLowerCase())
}

/** Split `content` into user lines (block removed) and whether any marker was present. */
function stripManagedBlock(lines: string[]): { userLines: Array<{ text: string; line: number }>; hadMarkers: boolean } {
  const endIndex = (from: number) => lines.findIndex((l, i) => i > from && l.trim() === KNOWN_HOSTS_BLOCK_END)
  const userLines: Array<{ text: string; line: number }> = []
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
        userEntries.filter(
          (u) => u.entry.keyType === entry.keyType && u.entry.hosts.some((p) => patternNamesHost(p, host))
        )
      const entryConflicts = hosts.flatMap((host) =>
        sameType(host)
          .filter((u) => u.entry.key !== entry.key)
          .map((u) => ({ host, keyType: entry.keyType, line: u.line }))
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
