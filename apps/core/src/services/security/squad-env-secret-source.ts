import { lstatSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseShellLiteralAssignments } from './shell-literal-assignments'
import { getSquadsBasePath, isCanonicalSquadId } from '../squad/workspace'
import type { SecretEntry } from './content-safety'

const SECRET_NAME = /(?:^|_)(?:TOKEN|KEY|SECRET|PASSWORD|CREDENTIALS)$/i

/** Literal values only; never source a shell file or evaluate substitutions. */
export function isSecretLikeSquadEnvValue(key: string, value: string): boolean {
  if (/PUBLIC|PUBLISHABLE/i.test(key) || /^(?:NEXT_PUBLIC_|VITE_|REACT_APP_)/i.test(key)) return false
  if (value.length < 12) return false
  if (SECRET_NAME.test(key)) return true
  if (value.length < 32 || /\s/.test(value) || /^(?:https?:|\/|\.{1,2}\/|~\/)/i.test(value)) return false
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((pattern) => pattern.test(value)).length
  if (classes < 2) return false
  const counts = new Map<string, number>()
  for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1)
  let entropy = 0
  for (const count of counts.values()) {
    const probability = count / value.length
    entropy -= probability * Math.log2(probability)
  }
  return entropy >= 4
}

type CachedFile = { signature: string; entries: readonly SecretEntry[] }

/**
 * Process-wide output-only source. Reads ONLY canonical squad .ficus/env.user
 * files. Metadata is checked at each redaction boundary, so API/worker processes
 * and direct env.user edits need no notification race, watcher or polling job.
 * Unchanged files reuse parsed entries; no workspace-file secret scanning.
 */
export class SquadEnvSecretSource {
  #files = new Map<string, CachedFile>()
  #entries: readonly SecretEntry[] = []

  constructor(private readonly basePath: () => string = getSquadsBasePath) {}

  entries(): readonly SecretEntry[] {
    const base = this.basePath()
    let squads: string[]
    try {
      squads = readdirSync(base).filter(isCanonicalSquadId).sort()
    } catch (error) {
      // Preserve last-known coverage on transient I/O errors. A removed root,
      // unlike unreadable storage, authoritatively removes its env values.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return this.#entries
      squads = []
    }
    const next = new Map<string, CachedFile>()
    for (const id of squads) {
      const path = join(base, id, '.ficus', 'env.user')
      try {
        // Do not traverse links to arbitrary files outside the settings source.
        for (const dir of [join(base, id), join(base, id, '.ficus')]) {
          if (!lstatSync(dir).isDirectory()) throw Object.assign(new Error(), { code: 'ENOENT' })
        }
        const stat = lstatSync(path, { bigint: true })
        if (!stat.isFile()) continue
        const signature = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`
        const cached = this.#files.get(path)
        if (cached?.signature === signature) {
          next.set(path, cached)
          continue
        }
        const values = parseShellLiteralAssignments(readFileSync(path, 'utf8'))
        const entries = values
          .filter(({ key, value }) => isSecretLikeSquadEnvValue(key, value))
          .map(({ key, value }) => ({ key: `squad-env.${id}.${key}`, value, outputOnly: true as const }))
        next.set(path, { signature, entries })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          const cached = this.#files.get(path)
          if (cached) next.set(path, cached)
        }
      }
    }
    if (next.size !== this.#files.size || [...next].some(([path, entry]) => this.#files.get(path) !== entry)) {
      this.#entries = [...next.values()].flatMap((file) => file.entries)
      this.#files = next
    }
    return this.#entries
  }
}
