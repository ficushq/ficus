import { Command } from 'commander'
import { existsSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { basename, join, resolve } from 'path'
import { assertEnvFileNaming, expandTilde } from '@ficus/shared/node'
import { applyUpdate, type UpdateDeps } from './update'
import { bootstrap, defaultInstallDir, DEFAULT_REPO } from '../local-server/bootstrap'
import { parseEnvFile } from '../local-server/env-file'
import { recoveryCliHome, cliHome } from '../local-server/home-move'
import { runOfflineUpdate } from '../local-server/offline-update'
import { resolveSetupOptions, type Prompter, type RawSetupFlags, SetupOptionsError } from '../local-server/options'
import { defaultSysboxHostDeps, runSysboxBootstrap, type SysboxHostDeps } from '../local-server/sysbox'
import {
  containerVolumeName,
  ensurePostgresContainer,
  isManagedShapedUrl,
  parseDatabaseUrl,
  waitForPostgres,
} from '../local-server/postgres'
import {
  instanceNames,
  normalizeLabel,
  recordIdentity,
  requireCurrentIdentity,
  type InstanceIdentity,
} from '../local-server/instance'
import {
  assertNoRenameInFlight,
  RENAME_JOURNAL,
  renameIdentity,
  type RenameReport,
} from '../local-server/supervisor-rename'
import {
  logsSupervisor,
  makeSupervisorContext,
  restartSupervisor,
  startSupervisor,
  statusSupervisor,
  stopSupervisor,
  uninstallSupervisor,
  type SupervisorContext,
} from '../local-server/supervisor'
import { canPrompt, terminalPrompter } from '../local-server/prompt'
import { defaultRunner, type Runner } from '../local-server/runner'
import { defaultSetupDeps, runSetup, type SetupDeps } from '../local-server/setup'
import {
  canonicalRoot,
  defaultLabel,
  findInstanceByRoot,
  getStatePath,
  isCheckout,
  readRegistryListing,
  readRegistryStrict,
  removeInstance,
  resolveRoot,
  resolveSetupRoot,
  writeRegistry,
} from '../local-server/state'
import { LOCAL_SUPERVISORS, type LocalSupervisor, type SetupOptions } from '../local-server/types'
import { isJsonMode, output, outputError, setOutputOptions } from '../output'
import { startingPostgresLine } from '../local-server/steps'
import { narrate } from '../local-server/log'
import { webDistWarning } from '../local-server/web-dist'

export interface ServerDeps {
  runner: Runner
  env: Record<string, string | undefined>
  cwd: string
  statePath: string
  fetch: typeof fetch
  isTTY: boolean
  prompter: Prompter
  sleep(ms: number): Promise<void>
  setupDeps?(root: string): SetupDeps
  runSetup?(opts: SetupOptions, deps: SetupDeps): Promise<{ handoff: string[]; cliOnPath: boolean }>
  which(cmd: string): string | null
  sysboxHost?: SysboxHostDeps
  supervisorContext?(
    root: string,
    label: string,
    supervisor: LocalSupervisor,
    identity?: InstanceIdentity
  ): SupervisorContext
  /** `<cliHome>/rename-identity.journal`; tests point it elsewhere. */
  renameJournalPath?: string
}

export function defaultServerDeps(): ServerDeps {
  return {
    runner: defaultRunner,
    env: process.env,
    cwd: process.cwd(),
    statePath: getStatePath(),
    fetch,
    isTTY: canPrompt(),
    prompter: terminalPrompter(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    which: (cmd) => Bun.which(cmd),
  }
}

function rootEnv(root: string): Record<string, string> {
  const path = join(root, '.env')
  return existsSync(path) ? parseEnvFile(readFileSync(path, 'utf8')) : {}
}

/**
 * Checks that start/restart cannot fix but the operator must know about
 * (today: a web bundle built for another base path). Narrated as warnings
 * on a human run; under --json they ride in the document instead.
 */
function narrateWarnings(root: string): { warnings?: string[] } {
  const warnings = [webDistWarning(root, rootEnv(root))].filter((w): w is string => Boolean(w))
  if (warnings.length === 0) return {}
  if (!isJsonMode()) for (const warning of warnings) narrate(`  warning: ${warning}`)
  return { warnings }
}

/** Refuses (EnvNamingError) an install whose .env predates the Ficus naming, before anything starts. */
function assertInstallEnvNaming(root: string): void {
  assertEnvFileNaming(join(root, '.env'))
}

export function registerServerCommands(program: Command, deps: ServerDeps = defaultServerDeps()) {
  const server = program
    .command('server')
    .description('Manage the Ficus instance installed on this machine (no API needed)')
    .enablePositionalOptions()
  // Every command that resolves a checkout takes both, AFTER the subcommand:
  // `ficus server status --instance smoke`. Declaring --instance on the group
  // instead would shadow setup's own --instance (commander binds an option an
  // ancestor declares to that ancestor), silently dropping the label.
  const withRoot = (cmd: Command) =>
    cmd
      .option(
        '--root <dir>',
        'Checkout to operate on (default: FICUS_SERVER_ROOT, then --instance, then the current checkout, then the default instance)'
      )
      .option(
        '--instance <label>',
        'Instance to act on (default: FICUS_INSTANCE, the current checkout, then the default)'
      )
  const root = (opts: { root?: string; instance?: string }) =>
    resolveRoot({
      flag: opts.root,
      env: deps.env,
      instance: opts.instance,
      statePath: deps.statePath,
      cwd: deps.cwd,
    })
  // setup deliberately ignores the state file: it must configure the checkout you
  // are in, never the one that happens to be installed. See resolveSetupRoot.
  const setupRoot = (opts: { root?: string }) => resolveSetupRoot({ flag: opts.root, env: deps.env, cwd: deps.cwd })
  // The default instance's data dir when neither the checkout's .env nor its label names one:
  // the CLI home (`~/.ficus`, or a legacy home that has not moved yet), shown with a `~`.
  const defaultDataDir = () => join('~', basename(cliHome({ homedir: deps.env.HOME ?? homedir() })))
  const managed = (opts: { root?: string; instance?: string }) => {
    const selected = root(opts)
    const registered = findInstanceByRoot(selected, deps.statePath)
    if (!registered)
      throw new Error(`checkout ${selected} is not registered; run ficus server setup --root ${selected}`)
    // The requested path only selects an instance. Lifecycle operations use
    // the canonical registry-owned root so aliases cannot break ownership
    // markers or make subprocess cwd drift from setup's persisted identity.
    const dir = canonicalRoot(registered.record.root)
    requireCurrentIdentity(registered.record)
    const identity = recordIdentity(registered.record)
    const context =
      deps.supervisorContext?.(dir, registered.label, registered.record.supervisor, identity) ??
      makeSupervisorContext({
        supervisor: registered.record.supervisor,
        root: dir,
        label: registered.label,
        identity,
        runner: deps.runner,
        log: narrate,
        env: deps.env,
        which: deps.which,
      })
    return { dir, registered, context, names: instanceNames(registered.label, identity) }
  }
  const home = () => deps.env.HOME ?? homedir()
  // Resolved on every call: rename-identity moves the CLI home while it runs.
  const renameJournal = () => deps.renameJournalPath ?? join(cliHome({ homedir: home() }), RENAME_JOURNAL)
  /** Starting anything while a rename-identity run is unfinished would start the half-moved instance. */
  const assertNoRename = () => assertNoRenameInFlight(renameJournal())
  /** The registry record behind an --instance label whose checkout is gone, or undefined when it resolves normally. */
  const staleRegistration = (instance: string) => {
    const label = normalizeLabel(instance)
    const record = readRegistryStrict(deps.statePath).instances[label]
    return record && !isCheckout(record.root) ? { label, record } : undefined
  }
  const guarded =
    (fn: (...args: unknown[]) => Promise<void>) =>
    async (...args: unknown[]) => {
      try {
        await fn(...args)
      } catch (error) {
        const exitCode = error instanceof SetupOptionsError ? error.exitCode : 1
        // Set process.exitCode too: outputError exits the process itself in
        // production, but is mocked in tests, where this is what is observable.
        process.exitCode = exitCode
        outputError(error as Error, exitCode)
      }
    }

  server
    .command('install')
    .description('Clone Ficus, install deps and run its setup (the curl one-liner calls this)')
    .option('--root <dir>', 'Where to clone (default ~/.ficus/ficus) (must precede any pass-through setup flags)')
    .option('--repo <url>', 'Git repository', DEFAULT_REPO)
    .option('--ref <ref>', 'Branch or tag to check out', 'main')
    .allowUnknownOption()
    .passThroughOptions()
    .argument(
      '[setupArgs...]',
      'Flags forwarded to `bun run setup` — run `ficus server setup --help` for the full list (e.g. --instance lab --runtime host --yes)'
    )
    .addHelpText(
      'after',
      `
Examples:
  Install the first instance into ~/.ficus/ficus:
    $ ficus server install --runtime host --yes

  Install a SECOND instance that cannot collide with the first. --instance
  names every per-instance resource — services ficus-lab-api/ficus-lab-worker, the
  postgres container postgres-ficus-lab, and data under ~/.ficus-lab — so both run
  side by side. --root must come before the forwarded setup flags:
    $ ficus server install --root ~/.ficus/instances/lab --instance lab --runtime host --yes

  Address it afterwards (--instance is per subcommand, not global):
    $ ficus server status --instance lab
    $ ficus server update --instance lab
    $ ficus server list
`
    )
    .action(
      guarded(async (...args: unknown[]) => {
        const [setupArgs, opts] = args as [string[], Record<string, unknown>]
        // Installation mutates the clone destination before the checkout's
        // setup runs, so corrupt/forward registry state must fail closed here.
        readRegistryStrict(deps.statePath)
        const home = deps.env.HOME ?? homedir()
        const root = resolve(expandTilde((opts.root as string | undefined) ?? defaultInstallDir(home, deps.statePath)))
        const registered = findInstanceByRoot(root, deps.statePath)
        if (registered) requireCurrentIdentity(registered.record)
        await bootstrap(
          { root, repo: opts.repo as string, ref: opts.ref as string, setupArgs },
          { runner: deps.runner, which: deps.which, env: deps.env, home, log: narrate }
        )
      })
    )

  server
    .command('setup')
    .description('Configure, build, migrate and start Ficus in a checkout (idempotent)')
    .option(
      '--root <dir>',
      'Checkout to configure (default: FICUS_SERVER_ROOT, then the checkout the current directory is in)'
    )
    .option('--runtime <runtime>', 'host | docker-socket | docker-sysbox | k3d')
    .option('--supervisor <supervisor>', 'pm2 | launchd | systemd-user')
    .option('--instance <label>', 'Instance label — names every per-instance resource (default ficus)')
    .option('--home-dir <path>', 'HOME_DIR for Ficus data (default ~/.ficus)')
    .option('--port <n>', 'API/web port (default 3000)')
    .option('--app-url <origin>', 'Browser origin (default http://localhost:<port>)')
    .option('--database-url <dsn>', 'Use an existing PostgreSQL instead of the docker compose container')
    .option('--db-name <name>', 'Database name in the compose container (default ficus)')
    .option('--db-port <n>', 'Host port for the managed PostgreSQL (default 5432, else the first free port)')
    .option('--default', 'Make this instance the one `ficus server` commands act on by default')
    .option('--no-start', 'Do not start the services')
    .option('--dry-run', 'Print the plan and change nothing')
    .option('--yes', 'Accept defaults without confirmation')
    .option('--rebuild-image', 'Rebuild the docker sandbox image even if present')
    .action(
      guarded(async (raw) => {
        const dir = setupRoot(raw as { root?: string })
        // A re-run keeps what this checkout already is: its label and port come
        // from its own .env unless a flag or FICUS_SETUP_* says otherwise.
        const persistedEnv = rootEnv(dir)
        const persistedPort = Number(persistedEnv.PORT)
        const registered = findInstanceByRoot(dir, deps.statePath)?.record
        if (registered) requireCurrentIdentity(registered)
        const marked = persistedEnv.FICUS_UPDATE_SUPERVISOR
        const markedSupervisor = (LOCAL_SUPERVISORS as readonly string[]).includes(marked ?? '')
          ? (marked as LocalSupervisor)
          : undefined
        const legacyPm2 =
          existsSync(join(dir, 'ecosystem.config.js')) || persistedEnv.FICUS_SYSTEM_LOG_PROVIDER === 'pm2'
        const options = await resolveSetupOptions(
          { ...(raw as RawSetupFlags), root: dir },
          deps.env,
          deps.prompter,
          deps.isTTY,
          {
            instance: persistedEnv.FICUS_INSTANCE || undefined,
            port: Number.isInteger(persistedPort) && persistedPort > 0 ? persistedPort : undefined,
            supervisor: registered?.supervisor ?? markedSupervisor ?? (legacyPm2 ? 'pm2' : undefined),
          }
        )
        const setupDeps = deps.setupDeps
          ? deps.setupDeps(dir)
          : {
              ...defaultSetupDeps(dir, deps.runner),
              statePath: deps.statePath,
              isTTY: deps.isTTY,
              confirm: (question: string) => deps.prompter.confirm(question),
              // Reuse the CLI's own injected env/which (defaultSetupDeps otherwise reads
              // process.env/Bun.which directly) so the end-of-setup PATH check honours
              // the same test doubles as the rest of this command.
              env: deps.env,
              which: deps.which,
              home: deps.env.HOME ?? homedir(),
            }
        await (deps.runSetup ?? runSetup)(options, setupDeps)
      })
    )

  server
    .command('use')
    .description('Choose the instance bare `ficus server` commands act on (--instance still overrides per command)')
    .argument('<label>', 'Instance label, as shown by `ficus server list`')
    .action(
      guarded(async (...args: unknown[]) => {
        const label = args[0] as string
        const registry = readRegistryStrict(deps.statePath)
        if (!registry.instances[label]) {
          const known = Object.keys(registry.instances).sort()
          throw new Error(
            known.length === 0
              ? 'No local instances are registered — run `ficus server install` first'
              : `No local instance named '${label}' — known instances: ${known.join(', ')}`
          )
        }
        // Written even when it already IS the default: a registry whose
        // `default` line was lost or hand-edited to a stale label resolves to
        // the alphabetically-first instance, so `use` is also the repair.
        requireCurrentIdentity(registry.instances[label])
        registry.default = label
        writeRegistry(registry, deps.statePath)
        narrate(`Default instance: ${label} (${registry.instances[label].root})`)
      })
    )

  server
    .command('list')
    .description('List the Ficus instances installed on this machine')
    .option('--json', 'Output in JSON format')
    .action(
      guarded(async (opts) => {
        if ((opts as { json?: boolean }).json) setOutputOptions({ json: true })
        const { registry, unsupported } = readRegistryListing(deps.statePath)
        // The same answer resolveRoot uses, so the `*` can never point at an
        // instance a bare `ficus server` command would not act on.
        const def = defaultLabel(registry)
        // The default first, then alphabetically: the one you act on by
        // default is the one you look for first.
        const entries = Object.entries(registry.instances).sort(([a], [b]) =>
          a === def ? -1 : b === def ? 1 : a.localeCompare(b)
        )
        const rows: {
          label: string
          root: string
          port: number
          url: string
          default: boolean
          supervisor: LocalSupervisor
          processes: Awaited<ReturnType<typeof statusSupervisor>>
          /** Registered by a newer CLI: this one cannot derive its names, so it is shown, not queried. */
          unsupportedIdentity?: number
        }[] = []
        for (const [label, record] of entries) {
          if (unsupported.has(label) || record.identity !== 2) {
            rows.push({
              label,
              root: record.root,
              port: record.port,
              url: `http://localhost:${record.port}`,
              default: label === def,
              supervisor: record.supervisor,
              processes: [],
              unsupportedIdentity: record.identity ?? 1,
            })
            continue
          }
          let processes
          const identity = recordIdentity(record)
          try {
            const context =
              deps.supervisorContext?.(record.root, label, record.supervisor, identity) ??
              makeSupervisorContext({
                supervisor: record.supervisor,
                root: record.root,
                label,
                identity,
                runner: deps.runner,
                log: narrate,
                env: deps.env,
                which: deps.which,
              })
            processes = await statusSupervisor(context)
          } catch {
            const names = instanceNames(label, identity)
            processes = [names.api, names.worker].map((name) => ({
              name,
              status: 'unavailable',
              pid: 0,
              cwd: record.root,
            }))
          }
          rows.push({
            label,
            root: record.root,
            port: record.port,
            url: `http://localhost:${record.port}`,
            default: label === def,
            supervisor: record.supervisor,
            processes,
          })
        }
        const width = (pick: (r: (typeof rows)[number]) => string) => Math.max(0, ...rows.map((r) => pick(r).length))
        const labelW = width((r) => r.label)
        const rootW = width((r) => r.root)
        const urlW = width((r) => r.url)
        const text =
          rows.length === 0
            ? '(none) — run `ficus server setup` inside a checkout to install one'
            : rows
                .map((r) => {
                  if (r.unsupportedIdentity !== undefined)
                    return `${r.default ? '*' : ' '} ${r.label.padEnd(labelW)}  ${r.supervisor}  ${r.root.padEnd(rootW)}  ${r.url.padEnd(urlW)}  identity ${r.unsupportedIdentity}: ${r.unsupportedIdentity === 1 ? 'upgrade through ficus-host-layout-bridge first' : 'registered by a newer CLI — update this one to manage it'}`
                  const names = instanceNames(r.label, recordIdentity(registry.instances[r.label]))
                  const state = (name: string) => r.processes.find((p) => p.name === name)?.status ?? 'not registered'
                  const procs = `api: ${state(names.api)}  worker: ${state(names.worker)}`
                  return `${r.default ? '*' : ' '} ${r.label.padEnd(labelW)}  ${r.supervisor}  ${r.root.padEnd(rootW)}  ${r.url.padEnd(urlW)}  ${procs}`
                })
                .join('\n')
        output({ default: def, instances: rows }, text)
      })
    )

  withRoot(
    server.command('start').description('Start ficus-api and ficus-worker under the recorded supervisor')
  ).action(
    guarded(async (opts) => {
      assertNoRename()
      const { dir, names, context, registered } = managed(opts as { root?: string; instance?: string })
      assertInstallEnvNaming(dir)
      const url = rootEnv(dir).DATABASE_URL
      // A DSN the installer wrote (loopback, container credentials) is this
      // instance's own container, on the port it names. Anything else — a
      // remote database, or a loopback PostgreSQL with the operator's own
      // credentials — belongs to someone else and is left alone: a docker run
      // on its port could only fail with "port is already allocated".
      if (url && isManagedShapedUrl(url)) {
        // `--json` promises one machine-readable document on stdout; narration
        // would be noise in it.
        if (!isJsonMode()) narrate(startingPostgresLine(names.container))
        // A container recreated here boots the database the checkout already names.
        const { port, database } = parseDatabaseUrl(url)
        await ensurePostgresContainer(
          deps.runner,
          { container: names.container, volume: names.volume, port, database },
          { inherit: true }
        )
        await waitForPostgres(deps.runner, names.container, { sleep: deps.sleep })
      }
      await startSupervisor(context)
      const warnings = narrateWarnings(dir)
      output(
        { ok: true, root: dir, instance: names.label, supervisor: registered.record.supervisor, ...warnings },
        `Started instance "${names.label}" from ${dir}`
      )
    })
  )
  withRoot(server.command('stop').description('Stop ficus-api and ficus-worker')).action(
    guarded(async (opts) => {
      const { dir, names, context, registered } = managed(opts as { root?: string; instance?: string })
      await stopSupervisor(context)
      output(
        { ok: true, root: dir, instance: names.label, supervisor: registered.record.supervisor },
        `Stopped instance "${names.label}" (${dir})`
      )
    })
  )
  withRoot(server.command('restart').description('Restart ficus-api and ficus-worker')).action(
    guarded(async (opts) => {
      assertNoRename()
      const { dir, names, context, registered } = managed(opts as { root?: string; instance?: string })
      assertInstallEnvNaming(dir)
      await restartSupervisor(context)
      const warnings = narrateWarnings(dir)
      output(
        { ok: true, root: dir, instance: names.label, supervisor: registered.record.supervisor, ...warnings },
        `Restarted instance "${names.label}" (${dir})`
      )
    })
  )

  withRoot(server.command('status').description('Show the local instance: root, processes, health')).action(
    guarded(async (opts) => {
      const { dir, names, context, registered } = managed(opts as { root?: string; instance?: string })
      const port = registered.record.port
      const processes = await statusSupervisor(context)
      const commit = (await deps.runner(['git', 'rev-parse', '--short', 'HEAD'], { cwd: dir })).stdout.trim()
      let health = 'unreachable'
      try {
        const res = await deps.fetch(`http://localhost:${port}/health`)
        // /health is the core's public liveness route (200). 401 still counts as
        // up: a reverse proxy in front of the instance may gate it, and a
        // rejection can only come from something that is answering.
        health = res.status === 200 || res.status === 401 ? 'ok' : `http ${res.status}`
      } catch {
        /* down */
      }
      const data = {
        root: dir,
        instance: names.label,
        port,
        api: `http://localhost:${port}`,
        supervisor: registered.record.supervisor,
        runtime: rootEnv(dir).FICUS_SANDBOX_RUNTIME ?? '(unset)',
        commit,
        processes,
        health,
      }
      const procText = [names.api, names.worker]
        .map((name) => `${name}: ${processes.find((p) => p.name === name)?.status ?? 'not registered'}`)
        .join('  ')
      output(
        data,
        `instance: ${names.label}\nsupervisor: ${registered.record.supervisor}\nroot:     ${dir}\napi:      http://localhost:${port}\nruntime:  ${data.runtime}\ncommit:   ${commit}\nhealth:   ${health}\n${procText}`
      )
    })
  )

  withRoot(
    server
      .command('update')
      .description('Alias of `ficus update apply --offline`: pull, build and restart the local checkout')
  )
    .option('--ref <ref>', 'Check out this branch, tag, or commit instead of fast-forwarding')
    .action(
      guarded(async (opts) => {
        assertNoRename()
        const { dir, registered, context } = managed(opts as { root?: string; instance?: string })
        const port = registered.record.port
        const updateDeps: UpdateDeps = {
          resolveRoot: () => dir,
          // `server update` is offline-only; these describe the checkout's own instance.
          apiUrl: () => `http://localhost:${port}`,
          localPort: () => port,
          offlineUpdate: (a) => runOfflineUpdate({ ...a, runner: deps.runner, context }),
          log: narrate,
        }
        await applyUpdate({ offline: true, ref: (opts as { ref?: string }).ref }, updateDeps)
      })
    )

  withRoot(
    server
      .command('rename-identity')
      .description(
        'Move an instance installed before the Ficus rename to the ficus names: supervisor labels and processes, ~/.ficus, its Postgres, .env and the registry'
      )
  )
    .option('--dry-run', 'Print the plan and change nothing')
    .option('--undo', 'Undo a completed rename of this instance (back to the old names)')
    .action(
      guarded(async (opts) => {
        const o = opts as { root?: string; instance?: string; dryRun?: boolean; undo?: boolean }
        const recoveryStatePath =
          !deps.env.FICUS_LOCAL_SERVER_STATE && deps.statePath === getStatePath(deps.env)
            ? join(recoveryCliHome(home()), 'cli', 'local-server.json')
            : deps.statePath
        const recoveryJournal = () => deps.renameJournalPath ?? join(recoveryCliHome(home()), RENAME_JOURNAL)
        const dir = resolveRoot({
          flag: o.root,
          instance: o.instance,
          env: deps.env,
          cwd: deps.cwd,
          statePath: recoveryStatePath,
        })
        const result: RenameReport = await renameIdentity(
          { root: dir, dryRun: o.dryRun === true, undo: o.undo === true },
          {
            runner: deps.runner,
            statePath: recoveryStatePath,
            journalPath: recoveryJournal,
            home: home(),
            fetch: deps.fetch,
            sleep: deps.sleep,
            now: () => new Date(),
            env: deps.env,
            log: isJsonMode() ? () => {} : narrate,
            supervisorContext: (id, checkout) =>
              deps.supervisorContext?.(checkout, id.label, id.supervisor, id.identity) ??
              makeSupervisorContext({
                supervisor: id.supervisor,
                root: checkout,
                label: id.label,
                identity: id.identity,
                runner: deps.runner,
                log: narrate,
                env: deps.env,
                which: deps.which,
              }),
          }
        )
        const summary =
          result.status === 'dry-run'
            ? `Dry run complete: "${result.from.label}" would become "${result.to.label}" (${result.to.api}, ${result.to.worker})`
            : result.status === 'already'
              ? `Instance "${result.from.label}" already runs under the ficus names`
              : result.status === 'undone'
                ? `Instance "${result.from.label}" runs under its old names again (${result.from.api}, ${result.from.worker})`
                : `Instance "${result.from.label}" is now "${result.to.label}" (${result.to.api}, ${result.to.worker})`
        output(result, summary)
      })
    )

  withRoot(server.command('logs').description('Show logs from the recorded supervisor'))
    .option('-c, --component <api|worker>', 'Only one component')
    .option('-n, --lines <n>', 'Lines of history', '100')
    .option('-f, --follow', 'Keep streaming')
    .action(
      guarded(async (opts) => {
        const o = opts as { root?: string; instance?: string; component?: string; lines?: string; follow?: boolean }
        const component = o.component
        if (component && component !== 'api' && component !== 'worker')
          throw new Error('--component must be api or worker')
        const lines = Number(o.lines)
        if (!Number.isInteger(lines) || lines < 0) throw new Error('--lines must be a non-negative integer')
        const { context } = managed(o)
        await logsSupervisor(context, {
          component: (component ?? 'all') as 'api' | 'worker' | 'all',
          lines,
          follow: o.follow === true,
        })
      })
    )

  // A host capability, not instance state: no --root/--instance (withRoot).
  server
    .command('bootstrap-sysbox')
    .description('Install the sysbox runtime this host needs for --runtime docker-sysbox')
    .option('--yes', 'Skip the confirmation')
    .option('--dry-run', 'Print the plan and change nothing')
    .action(
      guarded(async (opts) => {
        await runSysboxBootstrap(opts as { yes?: boolean; dryRun?: boolean }, {
          runner: deps.runner,
          isTTY: deps.isTTY,
          confirm: (message) => deps.prompter.confirm(message),
          host: deps.sysboxHost ?? defaultSysboxHostDeps(deps.which),
          log: (line) => process.stdout.write((line ?? '') + '\n'),
        })
      })
    )

  withRoot(
    server
      .command('uninstall')
      .description('Remove supervisor registrations and the registry entry; never deletes data')
  )
    .option('--yes', 'Skip confirmation')
    .action(
      guarded(async (opts) => {
        const o = opts as { root?: string; instance?: string; yes?: boolean }
        if (!o.yes && !deps.isTTY) throw new Error('uninstall needs a terminal to confirm — pass --yes')
        // A registration whose checkout was deleted by hand cannot be resolved
        // to a root, so managed() would refuse it — yet retiring it is exactly
        // what uninstall is for. Named by --instance, it is handled here.
        const stale = o.instance !== undefined ? staleRegistration(o.instance) : undefined
        if (stale) {
          const { label, record } = stale
          requireCurrentIdentity(record)
          if (
            !o.yes &&
            !(await deps.prompter.confirm(
              `Instance "${label}" is registered at ${record.root}, which no longer exists. Unregister it from ${record.supervisor}?`
            ))
          )
            return
          const identity = recordIdentity(record)
          const names = instanceNames(label, identity)
          // Best effort: the supervisor may still hold the processes/units, but
          // the checkout they ran from is gone, so run from the current directory
          // and never let a failure here keep the dead registration alive.
          let cleanup = `${record.supervisor} registrations removed`
          try {
            const context =
              deps.supervisorContext?.(deps.cwd, label, record.supervisor, identity) ??
              makeSupervisorContext({
                supervisor: record.supervisor,
                root: deps.cwd,
                label,
                identity,
                runner: deps.runner,
                log: narrate,
                env: deps.env,
                which: deps.which,
              })
            await uninstallSupervisor(context)
          } catch (error) {
            const reason = error instanceof Error ? error.message : String(error)
            cleanup = `supervisor cleanup failed (${reason}) — remove ${names.api} and ${names.worker} from ${record.supervisor} by hand`
          }
          removeInstance(label, deps.statePath)
          const home = names.homeDir ?? defaultDataDir()
          output(
            {
              ok: true,
              root: record.root,
              checkoutMissing: true,
              instance: label,
              unregistered: label,
              kept: [names.container, names.volume, home],
            },
            `Unregistered. The checkout ${record.root} no longer exists; ${cleanup}. Nothing else was deleted — remove by hand if you want to:\n  database:   docker rm -f ${names.container} && docker volume rm ${names.volume}\n  data:       ${home}\n  registry:   removed instance "${label}"`
          )
          return
        }
        const { dir, names, context, registered } = managed(o)
        if (!o.yes && !(await deps.prompter.confirm(`Unregister Ficus (${dir}) from ${registered.record.supervisor}?`)))
          return
        await uninstallSupervisor(context)
        removeInstance(registered.label, deps.statePath)
        // Everything this instance owns, named from its label: the container and
        // volume the installer created, and its data directory. Compose-derived
        // volume names follow the checkout's lowercased/stripped basename, so
        // discover the one docker actually has (falling back to the derived
        // name when docker cannot answer) rather than printing a guess.
        const volume = await containerVolumeName(deps.runner, names.container, names.volume)
        const home = rootEnv(dir).HOME_DIR ?? names.homeDir ?? defaultDataDir()
        // Name the registry this command actually read and wrote — under a
        // FICUS_LOCAL_SERVER_STATE override the default location is the wrong
        // file to go looking in.
        const registryLine = registered
          ? `removed instance "${registered.label}"`
          : `(not registered in ${deps.statePath})`
        output(
          {
            ok: true,
            root: dir,
            instance: names.label,
            unregistered: registered?.label,
            kept: [dir, names.container, volume, home],
          },
          `Unregistered. Nothing was deleted — remove by hand if you want to:\n  checkout:   ${dir}\n  database:   docker rm -f ${names.container} && docker volume rm ${volume}\n  data:       ${home}\n  registry:   ${registryLine}`
        )
      })
    )
}
