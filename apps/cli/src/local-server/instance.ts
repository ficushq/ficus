import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { parseEnvFile } from './env-file'
import {
  DEFAULT_INSTANCE_LABEL,
  LOCAL_INSTANCE_LABEL_RE,
  localProcessNames,
  normalizeLocalInstanceLabel,
} from '@ficus/shared'
import { FICUS_HOME_DIR_NAME } from '@ficus/shared/node'
import { SetupOptionsError } from './types'

/** The label of the default instance: `ficus-api`/`ficus-worker`, `postgres-ficus`, `~/.ficus`. */
export const DEFAULT_INSTANCE = DEFAULT_INSTANCE_LABEL

/**
 * Which names a registered instance runs under. 2: the ficus names (`ficus-*`, `sh.ficus.*`),
 * what setup registers. 1 is a retired registration and is refused by management commands.
 */
export type InstanceIdentity = 1 | 2
export const CURRENT_IDENTITY = 2

/** A registry entry's identity: `identity: 2`, or 1 for an entry written before the rename. */
export function recordIdentity(record: { identity?: number }): InstanceIdentity {
  return record.identity === CURRENT_IDENTITY ? CURRENT_IDENTITY : 1
}

/** Normal management requires the current identity. */
export function requireCurrentIdentity(record: { identity?: number }): void {
  if (record.identity !== CURRENT_IDENTITY)
    throw new SetupOptionsError(
      'this instance predates the Ficus identity — upgrade through the ficus-host-layout-bridge Core release first'
    )
}

export interface InstanceNames {
  label: string
  /** pm2 app names — also what FICUS_PM2_*_NAME must say for system-log streaming. */
  api: string
  worker: string
  /** docker container and volume of the installer-managed PostgreSQL. */
  container: string
  volume: string
  /** HOME_DIR default; undefined for the default instance, which uses the core's own default home. */
  homeDir: string | undefined
}

export function normalizeLabel(raw: string): string {
  try {
    return normalizeLocalInstanceLabel(raw)
  } catch {
    throw new SetupOptionsError(
      `--instance must match ${LOCAL_INSTANCE_LABEL_RE.source} after lowercasing — letters, digits and inner dashes, up to 31 characters (got "${raw}")`
    )
  }
}

/**
 * Every per-instance resource name, derived from one label by inserting `-<label>` after the
 * name stem: `ficus-<label>-api`, `postgres-ficus-<label>`, `~/.ficus-<label>`; the default label
 * gets the bare names. Retired registrations are refused rather than guessed from a label.
 */
export function instanceNames(raw: string, identity: InstanceIdentity = CURRENT_IDENTITY): InstanceNames {
  if (identity !== CURRENT_IDENTITY) throw new SetupOptionsError('retired local instance identity is not manageable')
  const { label, api, worker } = localProcessNames(raw)
  const isDefault = label === DEFAULT_INSTANCE
  const project = isDefault ? DEFAULT_INSTANCE : `${DEFAULT_INSTANCE}-${label}`
  return {
    label,
    api,
    worker,
    container: `postgres-${project}`,
    volume: `${project}_postgres-data`,
    homeDir: isDefault ? undefined : `~/${FICUS_HOME_DIR_NAME}-${label}`,
  }
}

/** The core's own defaults are PORT 3000 / WORKER_PORT 3002 / event port 3003. */
export function derivePorts(port: number): { workerPort: number; eventPort: number } {
  return { workerPort: port + 2, eventPort: port + 3 }
}

/**
 * The label a checkout belongs to. It is persisted as FICUS_INSTANCE at setup;
 * a checkout without one is the default instance. An unusable value throws
 * rather than defaulting: acting on the wrong instance is worse than failing.
 */
export function readInstanceLabel(root: string): string {
  const path = join(root, '.env')
  if (!existsSync(path)) return DEFAULT_INSTANCE
  const raw = parseEnvFile(readFileSync(path, 'utf8')).FICUS_INSTANCE?.trim()
  return raw ? normalizeLabel(raw) : DEFAULT_INSTANCE
}

const SUBSTITUTIONS = [
  { line: "name: 'ficus-api',", of: (n: InstanceNames) => `name: '${n.api}',` },
  { line: "name: 'ficus-worker',", of: (n: InstanceNames) => `name: '${n.worker}',` },
  { line: "FICUS_PM2_API_NAME: 'ficus-api',", of: (n: InstanceNames) => `FICUS_PM2_API_NAME: '${n.api}',` },
  { line: "FICUS_PM2_WORKER_NAME: 'ficus-worker',", of: (n: InstanceNames) => `FICUS_PM2_WORKER_NAME: '${n.worker}',` },
]

/**
 * `ecosystem.config.js` for one instance: the example file with its four app
 * names rewritten and nothing else touched. A missing target is fatal — a
 * silently unsubstituted config would register the default instance's apps
 * from this checkout and fight the install that owns them.
 */
export function generateEcosystem(exampleText: string, names: InstanceNames): string {
  let out = exampleText
  for (const sub of SUBSTITUTIONS) {
    const parts = out.split(sub.line)
    if (parts.length !== 2) {
      throw new Error(
        `ecosystem.config.example.js must contain exactly one \`${sub.line}\` line to generate a per-instance config (found ${parts.length - 1})`
      )
    }
    out = parts.join(sub.of(names))
  }
  return out
}
