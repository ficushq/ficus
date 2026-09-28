import { DEFAULT_INSTANCE, normalizeLabel } from './instance'
import { DB_NAME_RE } from './postgres'
import {
  LOCAL_RUNTIMES,
  LOCAL_SUPERVISORS,
  RUNTIME_DESCRIPTIONS,
  SetupOptionsError,
  type ExplicitKey,
  type LocalRuntime,
  type LocalSupervisor,
  type SetupOptions,
} from './types'

export { SetupOptionsError }

export interface RawSetupFlags {
  root?: string
  runtime?: string
  supervisor?: string
  instance?: string
  homeDir?: string
  port?: string
  dbPort?: string
  /** commander's name for --default */
  default?: boolean
  appUrl?: string
  databaseUrl?: string
  dbName?: string
  start?: boolean // commander sets false for --no-start
  dryRun?: boolean
  yes?: boolean
  rebuildImage?: boolean
}

export interface Prompter {
  select(question: string, choices: { value: string; label: string }[]): Promise<string>
  confirm(question: string): Promise<boolean>
}

const ENV_PREFIX = 'FICUS_SETUP_'
const ENV_KEYS = {
  runtime: 'RUNTIME',
  supervisor: 'SUPERVISOR',
  instance: 'INSTANCE',
  dbPort: 'DB_PORT',
  homeDir: 'HOME_DIR',
  port: 'PORT',
  appUrl: 'APP_URL',
  databaseUrl: 'DATABASE_URL',
  dbName: 'DB_NAME',
} as const

function pick<K extends keyof typeof ENV_KEYS>(
  key: K,
  raw: RawSetupFlags,
  env: Record<string, string | undefined>
): { value?: string; explicit: boolean } {
  const flag = raw[key]
  if (typeof flag === 'string' && flag !== '') return { value: flag, explicit: true }
  const fromEnv = env[`${ENV_PREFIX}${ENV_KEYS[key]}`]
  if (fromEnv) return { value: fromEnv, explicit: true }
  return { explicit: false }
}

export function assertBareOrigin(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new SetupOptionsError(`--app-url must be a bare origin like http://localhost:3000 (got "${value}")`)
  }
  if (url.pathname !== '/' || url.search || url.hash || !url.host) {
    throw new SetupOptionsError(
      `--app-url must be a bare origin (scheme://host[:port], no path) — anything else breaks passkeys (got "${value}")`
    )
  }
  return url.origin
}

/**
 * The DSN of the installer-managed container. The only place it is spelled:
 * setup recomposes it once the host port is resolved, so `.env`, the
 * migration run and the readiness probe can never disagree.
 */
export function composeDatabaseUrl(dbPort: number, dbName: string): string {
  return `postgres://postgres:postgres@localhost:${dbPort}/${dbName}`
}

export function deriveUrls(port: number, appUrl?: string): { apiUrl: string; appUrl: string } {
  const apiUrl = `http://localhost:${port}`
  return { apiUrl, appUrl: appUrl ? assertBareOrigin(appUrl) : apiUrl }
}

const FLAG_HELP = `Set --runtime <${LOCAL_RUNTIMES.join('|')}> (or FICUS_SETUP_RUNTIME). Supervisor: --supervisor <${LOCAL_SUPERVISORS.join('|')}> (or FICUS_SETUP_SUPERVISOR). Other flags: --instance, --home-dir, --port, --app-url, --database-url | --db-name | --db-port, --default, --no-start, --dry-run, --yes, --rebuild-image.`

/** What this checkout already chose (its .env) — used when no flag or env says otherwise. */
export interface PersistedSetupValues {
  supervisor?: LocalSupervisor
  instance?: string
  port?: number
}

export async function resolveSetupOptions(
  raw: RawSetupFlags,
  env: Record<string, string | undefined>,
  prompter: Prompter,
  isTTY: boolean,
  persisted: PersistedSetupValues = {},
  platform: NodeJS.Platform = process.platform
): Promise<SetupOptions> {
  const explicit = new Set<ExplicitKey>()

  const runtimePick = pick('runtime', raw, env)
  let runtime: string | undefined = runtimePick.value
  if (runtimePick.explicit) explicit.add('runtime')
  if (runtime === 'k8s' || runtime === 'vm') {
    throw new SetupOptionsError(
      `The ${runtime} runtime needs a cluster / machine fleet and is not set up by this installer — see docs/wiki/sandbox-runtimes.md. Local choices: ${LOCAL_RUNTIMES.join(', ')}.`
    )
  }
  if (!runtime) {
    if (!isTTY) throw new SetupOptionsError(`No terminal and no runtime chosen. ${FLAG_HELP}`)
    runtime = await prompter.select(
      'Where should agents run?',
      LOCAL_RUNTIMES.map((value) => ({ value, label: `${value} — ${RUNTIME_DESCRIPTIONS[value]}` }))
    )
    explicit.add('runtime')
  }
  if (!(LOCAL_RUNTIMES as readonly string[]).includes(runtime)) {
    throw new SetupOptionsError(`Unknown runtime "${runtime}". ${FLAG_HELP}`)
  }

  const supervisorPick = pick('supervisor', raw, env)
  const supervisor =
    supervisorPick.value ??
    persisted.supervisor ??
    (platform === 'darwin' ? 'launchd' : platform === 'linux' ? 'systemd-user' : 'pm2')
  if (!(LOCAL_SUPERVISORS as readonly string[]).includes(supervisor)) {
    throw new SetupOptionsError(`Unknown supervisor "${supervisor}". ${FLAG_HELP}`)
  }
  if (supervisor === 'launchd' && platform !== 'darwin') {
    throw new SetupOptionsError('The launchd supervisor is supported only on macOS')
  }
  if (supervisor === 'systemd-user' && platform !== 'linux') {
    throw new SetupOptionsError('The systemd-user supervisor is supported only on Linux')
  }
  if (supervisorPick.explicit) explicit.add('supervisor')

  const portPick = pick('port', raw, env)
  const port = portPick.value !== undefined ? Number(portPick.value) : (persisted.port ?? 3000)
  // 65532 is the ceiling, not 65535: WORKER_PORT and FICUS_WORKER_EVENT_PORT are
  // derived as PORT+2 / PORT+3 and must still be legal ports.
  if (!Number.isInteger(port) || port < 1 || port > 65532) {
    throw new SetupOptionsError(`--port must be an integer between 1 and 65532 (got "${portPick.value ?? port}")`)
  }
  if (portPick.explicit) explicit.add('port')

  const instancePick = pick('instance', raw, env)
  if (instancePick.explicit) explicit.add('instance')
  const instanceValue = instancePick.value ?? persisted.instance
  const instance = instanceValue === undefined ? DEFAULT_INSTANCE : normalizeLabel(instanceValue)

  const appUrlPick = pick('appUrl', raw, env)
  if (appUrlPick.explicit) explicit.add('appUrl')
  const { apiUrl, appUrl } = deriveUrls(port, appUrlPick.value)

  const homeDirPick = pick('homeDir', raw, env)
  if (homeDirPick.explicit) explicit.add('homeDir')

  const dbPortPick = pick('dbPort', raw, env)
  const dbPort = dbPortPick.value === undefined ? undefined : Number(dbPortPick.value)
  if (dbPort !== undefined && (!Number.isInteger(dbPort) || dbPort < 1 || dbPort > 65535)) {
    throw new SetupOptionsError(`--db-port must be an integer between 1 and 65535 (got "${dbPortPick.value}")`)
  }
  if (dbPortPick.explicit) explicit.add('dbPort')

  const dbUrlPick = pick('databaseUrl', raw, env)
  const dbNamePick = pick('dbName', raw, env)
  if (dbUrlPick.explicit && dbNamePick.explicit) {
    throw new SetupOptionsError('--database-url and --db-name are mutually exclusive')
  }
  const dbName = dbNamePick.value ?? 'tau'
  if (!DB_NAME_RE.test(dbName)) {
    throw new SetupOptionsError(`--db-name must match ${DB_NAME_RE.source} (got "${dbName}")`)
  }
  if (dbUrlPick.explicit) explicit.add('databaseUrl')
  if (dbNamePick.explicit) explicit.add('dbName')
  const databaseMode = dbUrlPick.explicit ? 'external' : 'compose'
  const databaseUrl = dbUrlPick.value ?? composeDatabaseUrl(dbPort ?? 5432, dbName)

  return {
    root: raw.root ?? process.cwd(),
    runtime: runtime as LocalRuntime,
    supervisor: supervisor as LocalSupervisor,
    port,
    apiUrl,
    appUrl,
    homeDir: homeDirPick.value,
    databaseMode,
    databaseUrl,
    dbName,
    instance,
    dbPort,
    makeDefault: raw.default === true,
    start: raw.start !== false,
    dryRun: raw.dryRun === true,
    yes: raw.yes === true,
    rebuildImage: raw.rebuildImage === true,
    explicit,
  }
}
