import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

const dotenvInjected = new Map<string, string>()

/** Load variables from the deliberate runtime CWD .env without overriding existing values. */
export function loadEnv(options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): void {
  const env = options.env ?? process.env
  const cwd = options.cwd ?? process.cwd()
  const envPath = join(cwd, '.env')
  if (!existsSync(envPath)) return

  let contents: string
  try {
    contents = readFileSync(envPath, 'utf-8')
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? String(error.code) : String(error)
    process.stderr.write(`ficus: could not read .env in ${cwd} (${code}); continuing without it\n`)
    return
  }

  const parsed: Record<string, string | undefined> = {}
  for (const line of contents.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eqIdx = trimmed.indexOf('=')
    if (eqIdx === -1) continue
    const key = trimmed.slice(0, eqIdx).trim()
    let value = trimmed.slice(eqIdx + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    if (!(key in parsed)) parsed[key] = value
  }

  for (const [key, value] of Object.entries(parsed)) {
    if (value === undefined) continue
    // Record EVERY key parsed from the file, not just the ones we inject. Bun auto-loads
    // ./.env into process.env before any user code runs (the shipped CLI is dist/ficus.js under
    // `#!/usr/bin/env bun`), so by the time we get here the key is usually already set and we
    // inject nothing. A process value identical to the file's is indistinguishable from one we
    // injected, so it must be treated as implicit too — otherwise a stale repo .env outranks
    // the auth store, which is the whole point of this bookkeeping.
    if (env === process.env) dotenvInjected.set(key, value)
    if (env[key] === undefined) env[key] = value
  }
}

/** Return a value supplied by the runtime rather than injected from dotenv. */
export function getExplicitEnv(key: string): string | undefined {
  const value = process.env[key]
  return dotenvInjected.get(key) === value ? undefined : value
}

/** Return a value only while it still matches the value injected from dotenv. */
export function getDotenvEnv(key: string): string | undefined {
  const value = process.env[key]
  return dotenvInjected.get(key) === value ? value : undefined
}
