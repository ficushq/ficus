/**
 * A usage error: the CLI exits with `exitCode` and prints only the message.
 * It lives here (not in options.ts) so every module can throw one without
 * importing the option parser — instance.ts ↔ options.ts would be a cycle.
 */
export class SetupOptionsError extends Error {
  constructor(
    message: string,
    public exitCode: number = 2
  ) {
    super(message)
  }
}

/**
 * A setup step or check that cannot proceed: the CLI prints only the message.
 * Here for the same reason as SetupOptionsError — postgres.ts throws one and
 * steps.ts imports postgres.ts, so it cannot live in steps.ts.
 */
export class SetupFailure extends Error {}

export const LOCAL_RUNTIMES = ['host', 'docker-socket', 'docker-sysbox', 'k3d'] as const
export type LocalRuntime = (typeof LOCAL_RUNTIMES)[number]

export const LOCAL_SUPERVISORS = ['pm2', 'launchd', 'systemd-user'] as const
export type LocalSupervisor = (typeof LOCAL_SUPERVISORS)[number]

export const RUNTIME_DESCRIPTIONS: Record<LocalRuntime, string> = {
  host: 'no sandbox — agents run on this machine as you (fastest; zero isolation)',
  'docker-socket': 'containers via the host Docker socket (any Docker host, incl. macOS)',
  'docker-sysbox': 'containers with real Docker-in-Docker via sysbox (Linux + sysbox installed)',
  k3d: 'sandbox pods in a local k3d cluster (heaviest; matches the k8s runtime)',
}

export type ExplicitKey =
  | 'supervisor'
  | 'runtime'
  | 'port'
  | 'appUrl'
  | 'homeDir'
  | 'databaseUrl'
  | 'dbName'
  | 'instance'
  | 'dbPort'

export interface SetupOptions {
  root: string
  runtime: LocalRuntime
  /** Process manager used for this local instance. */
  supervisor: LocalSupervisor
  port: number
  apiUrl: string
  appUrl: string
  homeDir?: string
  databaseMode: 'compose' | 'external'
  databaseUrl: string
  dbName: string
  /** Instance label: every per-instance name and the extra ports come from it. */
  instance: string
  /** PostgreSQL host port; undefined means "probe for a free one". */
  dbPort?: number
  /** Make this the instance `ficus server` commands act on without --instance. */
  makeDefault: boolean
  start: boolean
  dryRun: boolean
  yes: boolean
  rebuildImage: boolean
  /** Option names the operator set explicitly (flag or env) — they replace existing .env values. */
  explicit: Set<ExplicitKey>
}

export interface Step {
  id: string
  title: string
  /** Pure: what run() would do. Printed by --dry-run. */
  plan(): string[]
  run(): Promise<void>
}
