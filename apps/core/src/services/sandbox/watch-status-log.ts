/**
 * Compact, change-only logging for the workspace file watch that sandbox
 * ensure configures on every call.
 *
 * A squad's watch config can hold hundreds of include globs, so a log line
 * never carries the lists themselves: it carries their counts and a short
 * hash, which is enough to tell whether two observations describe the same
 * config. The full lists are the squad's `memory.workspacePaths` setting, and
 * the live sandbox reports its own copy through its `GET /watch` status route.
 */

import { createHash } from 'crypto'

/** Characters of the sha256 hex digest shown in log lines. */
const WATCH_CONFIG_HASH_LENGTH = 12

function patternCount(value: unknown): number {
  return Array.isArray(value) ? value.length : 0
}

/**
 * Short hash over the fields that decide whether a running watch matches the
 * desired one (include, exclude and squad id, in that order). Other fields a
 * watcher may report, such as a callback URL, are left out so they never
 * reach a log line in any form.
 */
export function watchConfigHash(config: { include?: unknown; exclude?: unknown; squadId?: unknown }): string {
  const canonical = JSON.stringify({
    include: config.include ?? null,
    exclude: config.exclude ?? null,
    squadId: config.squadId ?? null,
  })
  return createHash('sha256').update(canonical).digest('hex').slice(0, WATCH_CONFIG_HASH_LENGTH)
}

/** `include=<n> exclude=<n> hash=<hash>`, or `none` when there is no config. */
export function summarizeWatchConfig(
  config: { include?: unknown; exclude?: unknown; squadId?: unknown } | null | undefined
): string {
  if (!config || typeof config !== 'object') return 'none'
  return `include=${patternCount(config.include)} exclude=${patternCount(config.exclude)} hash=${watchConfigHash(config)}`
}

/**
 * Remembers the last state seen per key so a caller can log at info only when
 * that state changes. Keys are per squad, so the map is bounded by the number
 * of squads this process ensures.
 */
export class WatchStateTracker {
  private readonly lastState = new Map<string, string>()

  /** Record `state` for `key`; true when it differs from the previous record (or there was none). */
  changed(key: string, state: string): boolean {
    if (this.lastState.get(key) === state) return false
    this.lastState.set(key, state)
    return true
  }

  /** Overwrite the recorded state without reporting a change. */
  set(key: string, state: string): void {
    this.lastState.set(key, state)
  }

  forget(key: string): void {
    this.lastState.delete(key)
  }

  clear(): void {
    this.lastState.clear()
  }
}
