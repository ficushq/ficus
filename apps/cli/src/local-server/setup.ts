import { randomBytes } from 'crypto'
import { existsSync, readFileSync } from 'fs'
import { homedir, platform } from 'os'
import { join } from 'path'
import { checkCliOnPath, cliPathHintLines, detectShell, safeRealpath } from './cli-path'
import { parseEnvFile } from './env-file'
import { assertEnvFileNaming, checkoutPackageName } from '@ficus/shared/node'
import { CURRENT_IDENTITY, DEFAULT_INSTANCE, instanceNames, recordIdentity } from './instance'
import { composeDatabaseUrl } from './options'
import {
  DB_NAME_RE,
  findFreePort,
  isManagedPostgresUrl,
  isManagedShapedUrl,
  isPortInUse,
  parseDatabaseUrl,
  publishedPort,
} from './postgres'
import { defaultPreflightDeps, runPreflight, type PreflightDeps } from './preflight'
import { canPrompt, terminalPrompter } from './prompt'
import { defaultRunner, type Runner } from './runner'
import { RETIRED_DEFAULT_INSTANCE, canonicalRoot, getStatePath, readRegistryStrict, upsertInstance } from './state'
import { buildSteps, SetupFailure, type Secrets, type StepDeps } from './steps'
import type { ExplicitKey, SetupOptions } from './types'
import { narrate } from './log'
import { defaultDesktopDeps, installDesktop } from '../desktop-installer'

export { SetupFailure }

export interface SetupDeps extends StepDeps {
  preflight: PreflightDeps
  now(): string
  statePath: string
  /** A real terminal on both stdin and stderr — the only case that may prompt. */
  isTTY: boolean
  confirm(question: string): Promise<boolean>
  /** For the end-of-setup PATH check: resolve a command on PATH, null when not found. */
  which(cmd: string): string | null
  env: Record<string, string | undefined>
  home: string
  desktopPlatform?: string
  installDesktopApp?(): Promise<void>
}

export function defaultSetupDeps(root: string, runner: Runner = defaultRunner): SetupDeps {
  const secrets: Secrets = {
    hex32: () => randomBytes(32).toString('hex'),
    token: () => randomBytes(24).toString('base64url'),
  }
  return {
    runner,
    preflight: defaultPreflightDeps(root, runner),
    secrets,
    fetch,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => new Date().toISOString(),
    statePath: getStatePath(),
    isTTY: canPrompt(),
    confirm: (question) => terminalPrompter().confirm(question),
    log: narrate,
    which: (cmd) => Bun.which(cmd),
    env: process.env,
    home: process.env.HOME ?? homedir(),
    desktopPlatform: platform(),
    installDesktopApp: async () => {
      await installDesktop(defaultDesktopDeps())
    },
  }
}

/**
 * The login page consumes `#setup=<password>` (a URL FRAGMENT: never sent to
 * the server, never in access logs or history) and signs in with the
 * instance password so the first passkey can be created without pasting it.
 */
export function bootstrapLoginUrl(appUrl: string, password: string): string {
  return `${appUrl}/#setup=${encodeURIComponent(password)}`
}

/**
 * `cliHint` is the pre-computed {@link cliPathHintLines} block: whether
 * `ficus` is on PATH depends on the process environment, so `runSetup`
 * resolves it and hands the finished lines in, keeping this function pure
 * and easy to test with any combination directly.
 */
export function handoffLines(opts: SetupOptions, password?: string, cliHint: string[] = []): string[] {
  return [
    '',
    `Ficus is running at ${opts.appUrl}`,
    '',
    'Next steps:',
    password
      ? `  1. Open ${bootstrapLoginUrl(opts.appUrl, password)} — it signs you in with the instance password`
      : `  1. Open ${opts.appUrl} and sign in with the instance password (FICUS_PASSWORD in ${opts.root}/.env)`,
    '     (FICUS_PASSWORD in .env; it stops working once an admin exists), then create your account —',
    '     the first passkey becomes the admin. Email is not configured, so the verification code is shown in the page.',
    '  2. Sign in to an AI provider: Settings > AI Providers.',
    `  3. CLI: \`ficus auth login local --api-url ${opts.apiUrl}\` (after step 1; until then \`ficus\` works from ${opts.root}).`,
    ...(cliHint.length > 0 ? ['', ...cliHint] : []),
    '',
    'Manage it:  ficus server status | logs -f | restart | stop      Update:  ficus server update',
    opts.supervisor === 'launchd'
      ? 'Supervisor: launchd (starts again at the next GUI login; it does not run while logged out).'
      : `Supervisor: ${opts.supervisor}.`,
    ...(opts.supervisor === 'pm2'
      ? [`Start on boot (optional, needs sudo):  cd ${opts.root} && bunx pm2 startup`]
      : []),
  ]
}

/** The FICUS_INSTANCE this checkout's .env names, if any. */
function persistedLabel(root: string): string | undefined {
  const path = join(root, '.env')
  if (!existsSync(path)) return undefined
  return parseEnvFile(readFileSync(path, 'utf8')).FICUS_INSTANCE?.trim() || undefined
}

/** The DATABASE_URL this checkout already carries, if it has one. */
function persistedDatabaseUrl(root: string): string | undefined {
  const path = join(root, '.env')
  if (!existsSync(path)) return undefined
  return parseEnvFile(readFileSync(path, 'utf8')).DATABASE_URL || undefined
}

/**
 * Pin the managed PostgreSQL's host port and database name before any step is
 * built, so `.env`, the migration and the readiness probe all speak of the
 * same database. A persisted loopback DATABASE_URL with credentials other
 * than the container's is a PostgreSQL the operator runs: always external,
 * never probed, never built over. Otherwise the order is: an explicit
 * --db-port; the port the instance's own container already publishes,
 * running or stopped (its mapping is fixed at creation — the installer
 * follows it, never the other way round); the port a persisted
 * installer-written DATABASE_URL names, provided nothing foreign listens
 * there; 5432 for the default instance (what every existing install has);
 * otherwise the first free port from 5433 up.
 */
export async function resolveDatabase(opts: SetupOptions, deps: SetupDeps): Promise<SetupOptions> {
  const names = instanceNames(opts.instance)
  const persisted = persistedDatabaseUrl(opts.root)
  // --db-port / --db-name are requests to manage a container.
  const directed = opts.dbPort !== undefined || opts.explicit.has('dbName')
  // Loopback does not prove it is OUR container: a native PostgreSQL install
  // answers on localhost too. The DSN's credentials say whose it is — anything
  // but the container defaults is the operator's own database. Whether it
  // answers right now is beside the point, so it is not probed; and a flag that
  // asks for a container cannot be honoured without silently abandoning it.
  if (persisted && isManagedPostgresUrl(persisted) && !isManagedShapedUrl(persisted)) {
    if (directed) {
      throw new SetupFailure(
        `this checkout's DATABASE_URL points at a Postgres the installer does not manage (${persisted}); pass --database-url to change it, or remove DATABASE_URL from .env to let setup manage a container`
      )
    }
    return { ...opts, databaseMode: 'external', databaseUrl: persisted, dbPort: parseDatabaseUrl(persisted).port }
  }
  const container = await publishedPort(deps.runner, names.container)
  if (opts.dbPort !== undefined && container !== undefined && container !== opts.dbPort) {
    throw new SetupFailure(
      `container ${names.container} publishes ${container}, not ${opts.dbPort}; pass --db-port ${container} or remove the container`
    )
  }
  // A DSN the installer wrote. One on another host is the operator's own
  // database, and pins nothing here.
  const ours = persisted && isManagedShapedUrl(persisted) ? parseDatabaseUrl(persisted) : undefined
  // With a container of ours in existence its published port simply outranks
  // a stale line (whoever holds the old port now is not this run's business,
  // so it is not even probed). With no container, a listener on the port the
  // line names is a container-shaped collision (another checkout, an old
  // label, a leftover) that silently sharing would corrupt.
  if (ours && !directed && container === undefined && (await isPortInUse(ours.port, deps.connect))) {
    const free = await findFreePort(ours.port + 1, deps.connect)
    throw new SetupFailure(
      `port ${ours.port} is in use but is not container ${names.container} — stop whatever listens there, pass --db-port ${free}, or use --database-url for an external database`
    )
  }
  const dbPort =
    opts.dbPort ??
    container ??
    ours?.port ??
    (opts.instance === DEFAULT_INSTANCE ? 5432 : await findFreePort(5433, deps.connect))
  // The database the checkout already points at is the one that holds its data:
  // adopt its name too, or ensureDatabase would create the default while the app and
  // the migration ran against the other one.
  const dbName = opts.explicit.has('dbName') ? opts.dbName : ours?.database || opts.dbName
  // Adopted from a DSN, so it has never been through --db-name's validation,
  // and it is about to be interpolated into SQL and a createdb argv.
  if (!DB_NAME_RE.test(dbName)) {
    throw new SetupFailure(
      `database name "${dbName}" from this checkout's DATABASE_URL is not a safe identifier — pass --db-name or --database-url`
    )
  }
  // A checkout with no DATABASE_URL of its own gets the one we just resolved —
  // it would otherwise inherit .env.example's, which names the default
  // instance's port. One it already carries stays, unless the port moved
  // (an existing container outranks a stale .env).
  const overwrite = persisted === undefined || (ours !== undefined && ours.port !== dbPort)
  const explicit = overwrite ? new Set<ExplicitKey>([...opts.explicit, 'dbPort']) : opts.explicit
  return { ...opts, dbPort, dbName, databaseUrl: composeDatabaseUrl(dbPort, dbName), explicit }
}

export async function runSetup(
  options: SetupOptions,
  deps: SetupDeps
): Promise<{ handoff: string[]; cliOnPath: boolean }> {
  const registry = readRegistryStrict(deps.statePath)
  const root = canonicalRoot(options.root)
  const canonicalOptions = { ...options, root }
  const rootOwner = Object.entries(registry.instances).find(([, record]) => canonicalRoot(record.root) === root)
  const labelOwner = registry.instances[options.instance]
  // Refuse an older registration rather than starting a second set of processes beside it.
  if (rootOwner && recordIdentity(rootOwner[1]) !== CURRENT_IDENTITY) {
    throw new SetupFailure(
      `this checkout is instance "${rootOwner[0]}" under its pre-rename names — upgrade through the ficus-host-layout-bridge Core release first`
    )
  }
  if (!rootOwner && persistedLabel(root) === RETIRED_DEFAULT_INSTANCE) {
    throw new SetupFailure(
      `this checkout's .env names a retired local instance, so setup could start a second copy beside it — upgrade through the ficus-host-layout-bridge Core release first, or use a fresh checkout`
    )
  }
  if (rootOwner && (rootOwner[0] !== options.instance || rootOwner[1].supervisor !== options.supervisor)) {
    throw new SetupFailure(
      `this checkout is registered as instance "${rootOwner[0]}" with ${rootOwner[1].supervisor}; run ficus server uninstall --root ${options.root}, then rerun setup with --supervisor ${options.supervisor}`
    )
  }
  if (labelOwner && canonicalRoot(labelOwner.root) !== root) {
    throw new SetupFailure(
      `instance "${options.instance}" is registered to another checkout (${labelOwner.root}); run ficus server uninstall --root ${labelOwner.root} before reusing the label`
    )
  }

  // This CLI writes FICUS_ settings: only a checkout whose package.json is named exactly "ficus"
  // reads them. Fail closed on anything else.
  const packageName = checkoutPackageName(root)
  if (packageName !== 'ficus') {
    throw new SetupFailure(
      `${root} is not a Ficus checkout: its package.json ${packageName === null ? 'could not be read' : `is named ${JSON.stringify(packageName)}`}, not "ficus"`
    )
  }
  // An install whose .env predates the Ficus naming stops here, before anything is written.
  assertEnvFileNaming(join(root, '.env'))

  deps.log(`Preflight (${options.runtime}, ${options.databaseMode} database, port ${options.port})`)
  const pre = await runPreflight(canonicalOptions, deps.preflight)
  for (const w of pre.warnings) deps.log(`  warning: ${w}`)
  if (pre.failures.length > 0) throw new SetupFailure(`Preflight failed:\n  - ${pre.failures.join('\n  - ')}`)

  const opts =
    canonicalOptions.databaseMode === 'compose' ? await resolveDatabase(canonicalOptions, deps) : canonicalOptions
  const steps = buildSteps(opts, deps)
  const logPlan = () => {
    for (const step of steps) {
      deps.log(`▸ ${step.title}`)
      for (const line of step.plan()) deps.log(`    ${line}`)
    }
  }
  if (opts.dryRun) {
    deps.log('')
    deps.log('Dry run — nothing will be changed. Plan:')
    logPlan()
    // A read-only PATH lookup, not a change — safe to report even in a dry run.
    const onPath = checkCliOnPath({ env: deps.env, home: deps.home, which: deps.which, realpath: safeRealpath }).onPath
    return { handoff: ['Dry run complete.'], cliOnPath: onPath }
  }

  // Spec §4.1: one confirmation showing the plan. Skipped by --yes, and never
  // shown headlessly (a non-TTY run has nobody to answer it).
  if (!opts.dryRun && !opts.yes && deps.isTTY) {
    deps.log('')
    deps.log('Plan:')
    logPlan()
    deps.log('')
    if (!(await deps.confirm('Proceed with setup?'))) throw new SetupFailure('Setup cancelled.')
  }

  const persistState = () => {
    const registry = readRegistryStrict(deps.statePath)
    const existing = registry.instances[opts.instance]
    upsertInstance(
      opts.instance,
      {
        root,
        port: opts.port,
        supervisor: opts.supervisor,
        createdAt:
          existing && canonicalRoot(existing.root) === root && existing.createdAt ? existing.createdAt : deps.now(),
        updatedAt: deps.now(),
        // Setup names everything the ficus way (see instanceNames).
        identity: CURRENT_IDENTITY,
      },
      // The first install is what a bare `ficus server` command means; a later
      // one only takes that over when the operator asks (--default).
      { makeDefault: opts.makeDefault || Object.keys(registry.instances).length === 0 },
      deps.statePath
    )
  }

  for (const step of steps) {
    deps.log(`▸ ${step.title}`)
    // Everything before the start step is already durable — persist state now so a
    // pm2-start/health-probe failure still leaves a state file `ficus server logs` can use.
    if (step.id === 'start') persistState()
    await step.run()
  }
  // Refresh updatedAt after a successful start (or write for the first time when --no-start).
  persistState()

  const password = parseEnvFile(readFileSync(join(opts.root, '.env'), 'utf8')).FICUS_PASSWORD || undefined
  // Re-check PATH right next to the steps that need it (step 3 runs `ficus`):
  // buried earlier in a long install log, the installer's own PATH warning is
  // easy to miss, and a `ficus` that only worked because it was invoked by an
  // absolute path so far offers no nearby sign that it is about to stop working.
  const cliStatus = checkCliOnPath({ env: deps.env, home: deps.home, which: deps.which, realpath: safeRealpath })
  const cliHint = cliPathHintLines(cliStatus, detectShell(deps.env))
  const handoff = opts.start
    ? handoffLines(opts, password, cliHint)
    : ['', `Setup complete (not started). Start it with: ficus server start --root ${opts.root}`]
  for (const line of handoff) deps.log(line)
  if (deps.desktopPlatform === 'darwin') {
    const hint = 'Install the macOS app any time with: ficus desktop'
    if (deps.isTTY && !opts.yes && (await deps.confirm('Install Ficus Desktop now?'))) {
      try {
        await deps.installDesktopApp?.()
      } catch {
        deps.log('Desktop installation did not complete. ' + hint)
      }
    } else deps.log(hint)
  }
  return { handoff, cliOnPath: cliStatus.onPath }
}
