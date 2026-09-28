import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { parseEnvFile } from './env-file'
import {
  DEFAULT_LOCAL_INSTANCE,
  LOCAL_INSTANCE_LABEL_RE,
  localProcessNames,
  normalizeLocalInstanceLabel,
} from '@ficus/shared'
import { SetupOptionsError } from './types'

/** The label of the instance every existing checkout already is: its names are today's names. */
export const DEFAULT_INSTANCE = DEFAULT_LOCAL_INSTANCE

export interface InstanceNames {
  label: string
  /** pm2 app names — also what FICUS_PM2_*_NAME must say for system-log streaming. */
  api: string
  worker: string
  /** docker container and volume of the installer-managed PostgreSQL. */
  container: string
  volume: string
  /** HOME_DIR default; undefined for the default instance, which uses the core's own ~/.tau. */
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
 * Every per-instance resource name, derived from one label by inserting
 * `-<label>` after `tau`. The default label yields the names this repo has
 * always used, so an existing install keeps its pm2 apps, container and data.
 */
export function instanceNames(raw: string): InstanceNames {
  const { label, api, worker } = localProcessNames(raw)
  if (label === DEFAULT_INSTANCE) {
    return {
      label,
      api,
      worker,
      container: 'postgres-tau',
      // What docker compose named it for a checkout in a directory called `tau`.
      volume: 'tau_postgres-data',
      homeDir: undefined,
    }
  }
  return {
    label,
    api,
    worker,
    container: `postgres-tau-${label}`,
    volume: `tau-${label}_postgres-data`,
    homeDir: `~/.tau-${label}`,
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
  { line: "name: 'tau-api',", of: (n: InstanceNames) => `name: '${n.api}',` },
  { line: "name: 'tau-worker',", of: (n: InstanceNames) => `name: '${n.worker}',` },
  { line: "FICUS_PM2_API_NAME: 'tau-api',", of: (n: InstanceNames) => `FICUS_PM2_API_NAME: '${n.api}',` },
  { line: "FICUS_PM2_WORKER_NAME: 'tau-worker',", of: (n: InstanceNames) => `FICUS_PM2_WORKER_NAME: '${n.worker}',` },
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
