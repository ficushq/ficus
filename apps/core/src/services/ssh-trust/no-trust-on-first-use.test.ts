import { describe, expect, it } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'fs'
import { join, relative, resolve } from 'path'

/**
 * Guard: no SSH invocation Core makes, and no box/sandbox tooling it ships,
 * trusts a host key on first use or skips checking. Every Core SSH path pins
 * person-confirmed keys (services/ssh-trust, remote-hosts/host-keys.ts).
 */

const repoRoot = resolve(import.meta.dir, '../../../../..')

/** Core and everything it ships onto machines and boxes. */
const SCANNED_ROOTS = [
  'apps/core/src',
  'packages/sandbox-server',
  'packages/shared/src',
  'scripts/machine',
  'apps/cli/src',
]

const WEAK_HOST_KEY_SETTINGS = [
  /accept-new/i,
  /StrictHostKeyChecking\s*[= ]\s*["']?(no|off|false)\b/i,
  /UserKnownHostsFile\s*[= ]\s*["']?\/dev\/null/i,
  /NoHostAuthenticationForLocalhost\s*[= ]\s*["']?yes/i,
]

/**
 * Operator-run installer scripts outside Core (they run on the operator's
 * machine before Core exists, against a VM just created or GitHub). Listed so
 * a new occurrence anywhere else fails; tracked as a follow-up.
 */
const KNOWN_OUT_OF_SCOPE: Record<string, number> = {
  'scripts/setup/lib.sh': 2,
}

const SOURCE = /\.(ts|tsx|js|mjs|sh|bash|py|conf|service|tmpl|ya?ml)$|(^|\/)(Dockerfile[^/]*|entrypoint[^/]*)$/

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry.startsWith('.')) continue
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) walk(path, out)
    else out.push(path)
  }
}

/** Comment lines (history and explanations) are not invocations. */
function isComment(line: string): boolean {
  return /^(\/\/|\/?\*|#)/.test(line.trim())
}

/** Test files assert the settings are ABSENT, so they mention them; only shipped code counts. */
function isTestFile(path: string): boolean {
  return /\.test\.(ts|tsx)$/.test(path) || /(^|\/)(__tests__|fixtures?)\//.test(path)
}

function offenders(root: string): string[] {
  const files: string[] = []
  walk(join(repoRoot, root), files)
  const found: string[] = []
  for (const file of files) {
    const rel = relative(repoRoot, file)
    if (!SOURCE.test(rel) || isTestFile(rel)) continue
    readFileSync(file, 'utf8')
      .split('\n')
      .forEach((line, i) => {
        if (!isComment(line) && WEAK_HOST_KEY_SETTINGS.some((re) => re.test(line)))
          found.push(`${rel}:${i + 1}: ${line.trim()}`)
      })
  }
  return found
}

describe('SSH host-key trust guard', () => {
  it('no Core or shipped box tooling uses accept-new, StrictHostKeyChecking no, or an empty known_hosts', () => {
    expect(SCANNED_ROOTS.flatMap(offenders)).toEqual([])
  })

  it('the out-of-scope installer exceptions do not grow', () => {
    for (const [file, max] of Object.entries(KNOWN_OUT_OF_SCOPE)) {
      const count = readFileSync(join(repoRoot, file), 'utf8')
        .split('\n')
        .filter((line) => WEAK_HOST_KEY_SETTINGS.some((re) => re.test(line))).length
      expect(count).toBeLessThanOrEqual(max)
    }
  })

  it('the patterns catch the forms ssh accepts', () => {
    for (const line of [
      "'-o', 'StrictHostKeyChecking=accept-new'",
      '  StrictHostKeyChecking no',
      '-o StrictHostKeyChecking=off',
      'UserKnownHostsFile /dev/null',
      '-o UserKnownHostsFile=/dev/null',
      'NoHostAuthenticationForLocalhost yes',
    ]) {
      expect(WEAK_HOST_KEY_SETTINGS.some((re) => re.test(line))).toBe(true)
    }
    expect(isComment('  StrictHostKeyChecking no')).toBe(false)
    expect(isComment(' * old `accept-new`')).toBe(true)
    // Strict pinning and an empty GLOBAL file (fewer trusted keys) are fine.
    for (const line of ['-o StrictHostKeyChecking=yes', '-o GlobalKnownHostsFile=/dev/null']) {
      expect(WEAK_HOST_KEY_SETTINGS.some((re) => re.test(line))).toBe(false)
    }
  })
})
