import type {
  GitHubCommitSigningSummary,
  IntegrationAuthorizationStart,
  IntegrationDeviceAuthorizationStatus,
} from '@ficus/shared'
import { Command } from 'commander'
import { apiDelete, apiGet, apiPost, apiPut } from '../client'
import { isJsonMode, output, outputError } from '../output'

const MAX_CREDENTIAL_BYTES = 16 * 1024

interface IntegrationCommandDependencies {
  readCredential: () => Promise<string>
}

export function registerIntegrationCommands(
  program: Command,
  dependencies: IntegrationCommandDependencies = { readCredential: readCredentialFromStdin }
): void {
  const integration = program.command('integration').description('Manage external integrations')
  integration
    .command('connect <provider>')
    .option('--connection <uuid>', 'Reconnect an existing account')
    .action(
      run(async (provider, options) => {
        const start = await apiPost<IntegrationAuthorizationStart>(
          `/api/integrations/providers/${provider}/authorization/start`,
          {
            returnTo: '/settings',
            ...(options.connection ? { connectionId: options.connection } : {}),
          }
        )
        if ('authorizationUrl' in start) {
          output(start)
          return
        }
        output({ verificationUri: start.verificationUri, userCode: start.userCode, expiresAt: start.expiresAt })
        let complete = false
        try {
          let interval = start.intervalSeconds
          for (;;) {
            await Bun.sleep(interval * 1000)
            const result = await apiPost<IntegrationDeviceAuthorizationStatus>(
              `/api/integrations/providers/github/authorization/device/${start.id}/poll`,
              {}
            )
            if (result.status === 'pending') {
              interval = Math.max(1, result.retryAfterSeconds)
              continue
            }
            if (result.status === 'failed') throw new Error(result.code)
            complete = true
            output({ connected: true })
            break
          }
        } finally {
          if (!complete)
            await apiPost(`/api/integrations/providers/github/authorization/device/${start.id}/cancel`, {}).catch(
              () => {}
            )
        }
      })
    )
  integration
    .command('exec <provider> <command...>')
    .description('Run a command with the current credential from an assigned connection')
    .requiredOption('--squad <uuid>')
    .option('--connection <uuid>', 'Use a specific attached account instead of the squad default')
    .allowUnknownOption(false)
    .action(
      run(async (provider, command: string[], options) => {
        const result = await apiPost<{ environment: Record<string, string> }>(
          `/api/squads/${options.squad}/integrations/${provider}/execute-environment`,
          {
            ...(options.connection ? { connectionId: options.connection } : {}),
          }
        )
        const environment = { ...process.env }
        delete environment.GH_TOKEN
        delete environment.GITHUB_TOKEN
        delete environment.GITHUB_USER
        const child = Bun.spawn(command, {
          env: { ...environment, ...result.environment },
          stdin: 'inherit',
          stdout: 'inherit',
          stderr: 'inherit',
        })
        const forward = (signal: NodeJS.Signals) => {
          child.kill(signal)
        }
        const interrupt = () => forward('SIGINT'),
          terminate = () => forward('SIGTERM')
        process.on('SIGINT', interrupt)
        process.on('SIGTERM', terminate)
        try {
          process.exitCode = await child.exited
        } finally {
          process.off('SIGINT', interrupt)
          process.off('SIGTERM', terminate)
        }
      })
    )

  integration
    .command('outputs')
    .description('List typed integration outputs for flow subscriptions')
    .action(run(async () => output(await apiGet('/api/integrations/outputs'))))
  integration
    .command('list')
    .description(
      'List connections of a provider. GitHub connections include commitSigning: state, account login and the committer emails signed. With --squad, list the accounts attached to that squad instead, with which of them sign its commits'
    )
    .requiredOption('--provider <key>')
    .option('--squad <uuid>', 'Show the accounts attached to this squad and its commit signing')
    .action(
      run(async ({ provider, squad }) =>
        showConnections(
          await apiGet(
            squad
              ? `/api/squads/${encodeURIComponent(squad)}/integrations/${encodeURIComponent(provider)}`
              : `/api/integrations/connections?provider=${encodeURIComponent(provider)}`
          )
        )
      )
    )
  integration
    .command('get <connection>')
    .description('Show one connection. GitHub connections include commitSigning, checked against GitHub')
    .action(run(async (connection) => showConnections(await apiGet(`/api/integrations/connections/${connection}`))))
  integration
    .command('create <provider>')
    .requiredOption('--api-base <url>')
    .requiredOption('--credential-stdin', 'Read bearer credential from stdin')
    .option('--display-name <name>', 'Display name')
    .action(
      run(async (provider, options) => {
        if (!options.credentialStdin) throw new Error('--credential-stdin is required')
        const credential = await dependencies.readCredential()
        output(
          await apiPost('/api/integrations/connections', {
            provider,
            displayName: options.displayName ?? 'Bigbrain',
            configuration: { version: 1, apiBase: options.apiBase },
            credential,
          })
        )
      })
    )
  integration
    .command('credential <connection>')
    .requiredOption('--credential-stdin')
    .option('--confirm-assigned', 'Confirm disabling this connection for assigned squads')
    .action(
      run(async (connection, options) =>
        output(
          await apiPut(`/api/integrations/connections/${connection}/credential`, {
            credential: await dependencies.readCredential(),
            ...(options.confirmAssigned ? { confirmAssigned: true } : {}),
          })
        )
      )
    )
  for (const action of ['validate', 'enable'] as const) {
    integration
      .command(`${action} <connection>`)
      .action(
        run(async (connection) => output(await apiPost(`/api/integrations/connections/${connection}/${action}`, {})))
      )
  }
  integration
    .command('disable <connection>')
    .option('--confirm-assigned', 'Confirm impact to assigned squads')
    .action(
      run(async (connection, options) =>
        output(
          await apiPost(`/api/integrations/connections/${connection}/disable`, {
            ...(options.confirmAssigned ? { confirmAssigned: true } : {}),
          })
        )
      )
    )
  integration
    .command('remove <connection>')
    .alias('rm')
    .option('--confirm-assigned', 'Confirm unassigning every squad using this connection')
    .action(
      run(async (connection, options) => {
        await apiDelete(
          `/api/integrations/connections/${connection}${options.confirmAssigned ? '?confirmAssigned=true' : ''}`
        )
        output({ removed: true })
      })
    )
  integration
    .command('assign <provider>')
    .requiredOption('--squad <uuid>')
    .requiredOption('--connection <uuid>')
    .option('--additional', 'Attach this account without changing the default')
    .action(
      run(async (provider, options) =>
        output(
          await apiPut(`/api/squads/${options.squad}/integrations/${provider}/assignment`, {
            connectionId: options.connection,
            ...(options.additional ? { makeDefault: false } : {}),
          })
        )
      )
    )
  integration
    .command('unassign <provider>')
    .requiredOption('--squad <uuid>')
    .option('--connection <uuid>', 'Detach a specific attached account')
    .action(
      run(async (provider, options) => {
        await apiDelete(
          `/api/squads/${options.squad}/integrations/${provider}/assignment${options.connection ? `?connectionId=${encodeURIComponent(options.connection)}` : ''}`
        )
        output({ assigned: false })
      })
    )

  integration
    .command('export-status <agent>')
    .action(run(async (agent) => output(await apiGet(`/api/agents/${agent}/external-export`))))
  integration
    .command('export-enable <agent>')
    .requiredOption('--connection <uuid>')
    .requiredOption('--consent', 'Explicitly consent to prospective eligible text export')
    .action(
      run(async (agent, options) => {
        if (!options.consent) throw new Error('--consent is required')
        output(
          await apiPost(`/api/agents/${agent}/external-export`, {
            connectionId: options.connection,
            consent: true,
            policyVersion: 1,
            projectionVersion: 1,
          })
        )
      })
    )
  integration.command('export-disable <agent>').action(
    run(async (agent) => {
      await apiDelete(`/api/agents/${agent}/external-export`)
      output({ state: 'disabled' })
    })
  )
}

const SIGNING_STATE = { on: 'on', off: 'off', needs_attention: 'needs attention' } as const

function commitSigningLine(
  signing: GitHubCommitSigningSummary,
  connectionId: unknown,
  isDefault?: boolean
): string | undefined {
  if (!signing || typeof signing !== 'object' || !(signing.state in SIGNING_STATE)) return undefined
  const signsFor = Array.isArray(signing.signsFor) && signing.signsFor.length ? signing.signsFor.join(', ') : undefined
  return (
    `  @${signing.login}${isDefault ? ' (squad default)' : ''}: ${SIGNING_STATE[signing.state]}` +
    (signsFor ? `, signs commits committed as ${signsFor}` : '') +
    ` [connection ${String(connectionId)}]`
  )
}

/**
 * Plain-text commit-signing summary of what `list`/`get` returned: one line per
 * GitHub account with its state and the committer emails it signs for. Empty
 * for other providers.
 */
export function commitSigningLines(data: unknown): string[] {
  const lines: (string | undefined)[] = []
  const squad = (data as { commitSigning?: { accounts?: unknown } } | null)?.commitSigning
  if (squad && Array.isArray(squad.accounts)) {
    for (const account of squad.accounts as (GitHubCommitSigningSummary & {
      connectionId: string
      isDefault: boolean
    })[])
      lines.push(commitSigningLine(account, account?.connectionId, account?.isDefault))
    if (lines.length === 0) return ['Commit signing: no GitHub account is attached to this squad.']
    return [
      'Commit signing (the committer email chooses the account; an account that is off leaves its commits unsigned; emails of no attached account are refused):',
      ...lines.filter((line): line is string => !!line),
    ]
  }
  for (const row of Array.isArray(data) ? data : [data]) {
    const connection = row as { id?: unknown; commitSigning?: GitHubCommitSigningSummary } | null
    if (connection?.commitSigning) lines.push(commitSigningLine(connection.commitSigning, connection.id))
  }
  const found = lines.filter((line): line is string => !!line)
  return found.length ? ['Commit signing:', ...found] : []
}

function showConnections(data: unknown): void {
  output(data)
  const lines = isJsonMode() ? [] : commitSigningLines(data)
  if (lines.length) output(lines, lines.join('\n'))
}

export async function readCredentialFromStdin(stream: AsyncIterable<Uint8Array> = Bun.stdin.stream()): Promise<string> {
  const chunks: Uint8Array[] = []
  let size = 0
  for await (const chunk of stream) {
    size += chunk.byteLength
    if (size > MAX_CREDENTIAL_BYTES) throw new Error('Credential exceeds maximum length')
    chunks.push(chunk)
  }
  const combined = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    combined.set(chunk, offset)
    offset += chunk.byteLength
  }
  const credential = new TextDecoder().decode(combined).replace(/[\r\n]+$/, '')
  if (!credential) throw new Error('Credential is required on stdin')
  return credential
}

function run<T extends unknown[]>(handler: (...args: T) => Promise<void>): (...args: T) => Promise<void> {
  return async (...args) => {
    try {
      await handler(...args)
    } catch (error) {
      outputError(error as Error)
    }
  }
}
