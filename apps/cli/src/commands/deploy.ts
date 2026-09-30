import { Command } from 'commander'
import { apiDelete, apiGet, apiPatch, apiPost } from '../client'
import { isJsonMode, output, outputError, outputTable } from '../output'

interface DeploymentProviderDefinition {
  id: string
  label: string
  supports: string[]
  cliPackages: string[]
  auth: string[]
  needsBillingFor: string[]
  docsUrl: string
}

interface AppDeployment {
  id: string
  squadId: string
  name: string
  provider: string
  url: string | null
  providerProjectUrl?: string | null
  environment: string
  status: string
  costRisk: string
  logsCommand?: string | null
  rollbackCommand?: string | null
  metadata: Record<string, unknown>
  createdAt: string
  updatedAt: string
  archivedAt?: string | null
}

interface LocalDeployment {
  id: string
  name: string
  status: string
  urlPathOrHost: string
  port: number
  mode: string
  visibility: string
  logPath?: string | null
  archivedAt?: string | null
}

interface LocalDeploymentLogs {
  localDeploymentId: string
  lines: string[]
}

export function registerDeployCommands(program: Command) {
  const deploy = program.command('deploy').description('Manage local app runs and external deployment records')
  registerExternalCommands(deploy)
  registerLocalCommands(deploy)
}

function registerExternalCommands(deploy: Command): void {
  const external = deploy.command('external').description('Manage external provider deployment records')

  external
    .command('providers')
    .description('List supported deployment providers')
    .action(async () => {
      try {
        const providers = await apiGet<DeploymentProviderDefinition[]>('/api/deploy/providers')
        if (isJsonMode()) {
          output(providers)
        } else {
          outputTable(
            providers.map((provider) => ({
              id: provider.id,
              label: provider.label,
              supports: provider.supports.join(','),
              auth: provider.auth.join(','),
              billing: provider.needsBillingFor.join(',') || '-',
            })),
            ['id', 'label', 'supports', 'auth', 'billing']
          )
        }
      } catch (error) {
        outputError(error as Error)
      }
    })

  external
    .command('list <squadId>')
    .description('List external provider deployment records for a squad')
    .option('--include-archived', 'Include archived external deployment records')
    .action(async (squadId, options) => {
      try {
        const query = options.includeArchived ? '?includeArchived=true' : ''
        const deployments = await apiGet<AppDeployment[]>(`/api/squads/${squadId}/deployments${query}`)
        if (isJsonMode()) output(deployments)
        else if (deployments.length === 0) console.log('No deployments recorded')
        else {
          outputTable(
            deployments.map((deployment) => ({
              id: deployment.id,
              name: deployment.name,
              provider: deployment.provider,
              environment: deployment.environment,
              status: deployment.status,
              url: deployment.url ?? '-',
              updated: deployment.updatedAt,
            })),
            ['id', 'name', 'provider', 'environment', 'status', 'url', 'updated']
          )
        }
      } catch (error) {
        outputError(error as Error)
      }
    })

  external
    .command('get <deploymentId>')
    .description('Show an external provider deployment record')
    .action(async (deploymentId) => {
      try {
        const deployment = await apiGet<AppDeployment>(`/api/deployments/${deploymentId}`)
        output(deployment, `Deployment ${deployment.id}: ${deployment.status}`)
      } catch (error) {
        outputError(error as Error)
      }
    })

  external
    .command('record <squadId>')
    .description('Record an external provider deployment for a squad')
    .requiredOption('--name <name>', 'Deployment display name')
    .requiredOption('--provider <provider>', 'Deployment provider id')
    .option('--url <url>', 'Deployed app URL')
    .option('--provider-project-url <url>', 'Provider project/dashboard URL')
    .option('--environment <environment>', 'Deployment environment')
    .option('--status <status>', 'Deployment status')
    .option('--cost-risk <costRisk>', 'Cost risk')
    .option('--app <path>', 'App path to store in metadata')
    .option('--logs-command <command>', 'Command to inspect deployment logs')
    .option('--rollback-command <command>', 'Command to roll back the deployment')
    .option('--metadata <json>', 'Additional JSON metadata (must not contain secrets)')
    .action(async (squadId, options) => {
      try {
        const metadata = parseMetadata(options.metadata)
        if (options.app) metadata.appPath = options.app
        const deployment = await apiPost<AppDeployment>(`/api/squads/${squadId}/deployments`, {
          name: options.name,
          provider: options.provider,
          url: options.url,
          providerProjectUrl: options.providerProjectUrl,
          environment: options.environment,
          status: options.status,
          costRisk: options.costRisk,
          logsCommand: options.logsCommand,
          rollbackCommand: options.rollbackCommand,
          metadata,
        })
        output(deployment, `Recorded deployment ${deployment.id}: ${deployment.status}`)
      } catch (error) {
        outputError(error as Error)
      }
    })

  external
    .command('archive <deploymentId>')
    .description('Archive an external provider deployment record')
    .action(async (deploymentId) => {
      try {
        const deployment = await apiDelete<AppDeployment>(`/api/deployments/${deploymentId}`)
        output(deployment, `Archived deployment ${deployment.id}: ${deployment.status}`)
      } catch (error) {
        outputError(error as Error)
      }
    })

  external
    .command('update <deploymentId>')
    .description('Update an external provider deployment record')
    .option('--name <name>', 'Deployment display name')
    .option('--url <url>', 'Deployed app URL')
    .option('--provider-project-url <url>', 'Provider project/dashboard URL')
    .option('--environment <environment>', 'Deployment environment')
    .option('--status <status>', 'Deployment status')
    .option('--cost-risk <costRisk>', 'Cost risk')
    .option('--logs-command <command>', 'Command to inspect deployment logs')
    .option('--rollback-command <command>', 'Command to roll back the deployment')
    .option('--metadata <json>', 'Replacement JSON metadata (must not contain secrets)')
    .action(async (deploymentId, options) => {
      try {
        const body: Record<string, unknown> = {}
        for (const key of [
          'name',
          'url',
          'providerProjectUrl',
          'environment',
          'status',
          'costRisk',
          'logsCommand',
          'rollbackCommand',
        ]) {
          if (options[key] !== undefined) body[key] = options[key]
        }
        if (options.metadata !== undefined) body.metadata = parseMetadata(options.metadata)
        const deployment = await apiPatch<AppDeployment>(`/api/deployments/${deploymentId}`, body)
        output(deployment, `Updated deployment ${deployment.id}: ${deployment.status}`)
      } catch (error) {
        outputError(error as Error)
      }
    })
}

function registerLocalCommands(deploy: Command): void {
  const local = deploy.command('local').description('Manage local app runs in squad sandboxes')

  local
    .command('list <squadId>')
    .description('List local app runs for a squad')
    .option('--include-archived', 'Include archived local app runs')
    .action(async (squadId, options) => {
      try {
        const query = options.includeArchived ? '?includeArchived=true' : ''
        const runs = await apiGet<LocalDeployment[]>(`/api/squads/${squadId}/local-deployments${query}`)
        if (isJsonMode()) output(runs)
        else if (runs.length === 0) console.log('No local app runs found')
        else outputTable(runs.map(toLocalRow), ['id', 'name', 'status', 'url', 'port', 'mode', 'visibility'])
      } catch (error) {
        outputError(error as Error)
      }
    })

  local
    .command('get <localDeploymentId>')
    .description('Show a local app run')
    .action(async (id) => {
      try {
        output(await apiGet<LocalDeployment>(`/api/local-deployments/${id}`))
      } catch (error) {
        outputError(error as Error)
      }
    })

  local
    .command('start <squadId>')
    .description('Start a managed local app run for a squad')
    .requiredOption('--name <name>', 'Local app name')
    .option(
      '--port <port>',
      'Application port. OMIT THIS: Ficus assigns a free port and passes it as $PORT, which is the only way it can ' +
        'guarantee the port is free. Boxes on one machine share a loopback, so an explicit port is rejected when ' +
        'another live deployment holds it.'
    )
    .requiredOption(
      '--command <command>',
      'Command to start the local app. Build it with $FICUS_APP_BASE_PATH as its base (exported to the process): ' +
        'it is / on hosted instances, where each app gets its own origin, and the /api/app/<id>/ path prefix ' +
        'otherwise. Vite `base`, Next `basePath`, CRA `PUBLIC_URL`. A build with the wrong base renders a blank ' +
        'page with 404s for /assets/....'
    )
    .option('--cwd <cwd>', 'Working directory inside the sandbox')
    .option('--env-secret-ref <key>', 'Secret Store key to expose to the process', collect, [])
    .option('--restart-policy <policy>', 'Restart policy (always|never)')
    .action(async (squadId, options) => createLocalDeployment(squadId, { ...options, mode: 'managed' }))

  local
    .command('attach <squadId>')
    .description('Attach a local app run to an already-running app port')
    .requiredOption('--name <name>', 'Local app name')
    // Required here, unlike `start`: the app is ALREADY listening somewhere, so
    // Ficus cannot choose. Still rejected if another live deployment holds it.
    .requiredOption('--port <port>', 'Port the already-running app listens on')
    .option(
      '--log-path <path>',
      'Path of a log file the app already writes (relative to the squad workspace, or absolute inside it) so ' +
        'the panel can stream it'
    )
    .action(async (squadId, options) => createLocalDeployment(squadId, { ...options, mode: 'attached' }))

  local
    .command('stop <id>')
    .description('Stop a local app run')
    .action((id) => mutateLocal(id, 'stop'))
  local
    .command('restart <id>')
    .description('Restart a managed local app run')
    .action((id) => mutateLocal(id, 'restart'))
  local
    .command('archive <id>')
    .description('Archive a local app run')
    .action((id) => archiveLocal(id))
  local
    .command('logs <id>')
    .description('Tail local app run logs')
    .option('--tail <lines>', 'Number of log lines', '100')
    .action(async (id, options) => {
      try {
        const result = await apiGet<LocalDeploymentLogs>(`/api/local-deployments/${id}/logs?tail=${options.tail}`)
        if (isJsonMode()) output(result)
        else console.log(result.lines.join('\n'))
      } catch (error) {
        outputError(error as Error)
      }
    })
}

async function createLocalDeployment(squadId: string, options: Record<string, unknown>): Promise<void> {
  try {
    const body = {
      name: options.name,
      // Omitted => the server assigns a free port and hands it to the app as
      // $PORT. Sending `undefined` (not a parsed NaN) is what selects that.
      ...(options.port === undefined ? {} : { port: parsePort(String(options.port)) }),
      mode: options.mode,
      command: options.command,
      cwd: options.cwd,
      envSecretRefs: options.envSecretRef,
      restartPolicy: options.restartPolicy,
      logPath: options.logPath,
    }
    const created = await apiPost<LocalDeployment>(`/api/squads/${squadId}/local-deployments`, body)
    printLocal(created)
  } catch (error) {
    outputError(error as Error)
  }
}

async function mutateLocal(id: string, action: 'stop' | 'restart'): Promise<void> {
  try {
    printLocal(await apiPost<LocalDeployment>(`/api/local-deployments/${id}/${action}`))
  } catch (error) {
    outputError(error as Error)
  }
}

async function archiveLocal(id: string): Promise<void> {
  try {
    printLocal(await apiDelete<LocalDeployment>(`/api/local-deployments/${id}`))
  } catch (error) {
    outputError(error as Error)
  }
}

function toLocalRow(run: LocalDeployment) {
  return {
    id: run.id,
    name: run.name,
    status: run.status,
    url: run.urlPathOrHost,
    port: run.port,
    mode: run.mode,
    visibility: run.visibility,
  }
}

function printLocal(run: LocalDeployment): void {
  if (isJsonMode()) {
    output(run)
    return
  }

  console.log(`Local app ${run.name} ${run.status}`)
  console.log(`  ID: ${run.id}`)
  console.log(`  URL: ${run.urlPathOrHost}`)
  console.log(`  Port: ${run.port}`)
  console.log(`  Mode: ${run.mode}`)
  if (run.logPath) console.log(`  Log path: ${run.logPath}`)
  console.log(`  Visibility: ${run.visibility}`)
}

function collect(value: string, previous: string[]): string[] {
  return previous.concat([value])
}

function parsePort(value: string): number {
  const port = Number.parseInt(value, 10)
  if (!Number.isFinite(port)) throw new Error(`Invalid port: ${value}`)
  return port
}

function parseMetadata(value: string | undefined): Record<string, unknown> {
  if (!value) return {}
  const parsed = JSON.parse(value) as unknown
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('metadata must be a JSON object')
  }
  return parsed as Record<string, unknown>
}
