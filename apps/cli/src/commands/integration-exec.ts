/** Token-free intent only; every descendant still asks Core to authorize the selected account. */
export const INTEGRATION_EXEC_SELECTION_ENV = 'FICUS_INTEGRATION_EXEC_SELECTION'

export interface IntegrationExecutionSelection {
  providerKey: string
  squadId: string
  connectionId: string
}

export function executionConnectionId(
  scope: Pick<IntegrationExecutionSelection, 'providerKey' | 'squadId'>,
  explicit: string | undefined,
  inherited: NodeJS.ProcessEnv = process.env
): string | undefined {
  if (explicit !== undefined) return explicit
  const raw = inherited[INTEGRATION_EXEC_SELECTION_ENV]
  if (raw === undefined) return undefined
  try {
    const selection = JSON.parse(raw) as IntegrationExecutionSelection | null
    if (
      !selection ||
      !(['providerKey', 'squadId', 'connectionId'] as const).every(
        (key) => typeof selection[key] === 'string' && selection[key].length > 0
      )
    )
      throw new Error()
    return selection.providerKey === scope.providerKey && selection.squadId === scope.squadId
      ? selection.connectionId
      : undefined
  } catch {
    // Never silently fall back to a different account or echo inherited data.
    throw new Error('Invalid integration execution selection context')
  }
}

/** Core returns names from ALL execution declarations, not just the selected/assigned providers. */
export interface IntegrationExecutionEnvironment {
  environment: Record<string, string>
  scrubVariables: string[]
}

export function commandExecutionEnvironment(
  inherited: NodeJS.ProcessEnv,
  result: IntegrationExecutionEnvironment,
  selection?: IntegrationExecutionSelection
): NodeJS.ProcessEnv {
  if (!Array.isArray(result.scrubVariables))
    throw new Error('Unsupported integration execution environment contract; update Core and CLI together')
  const environment = { ...inherited }
  for (const name of result.scrubVariables) delete environment[name]
  Object.assign(environment, result.environment)
  // A different scope/default execution must not carry an earlier account into its descendants.
  delete environment[INTEGRATION_EXEC_SELECTION_ENV]
  if (selection) environment[INTEGRATION_EXEC_SELECTION_ENV] = JSON.stringify(selection)
  return environment
}

/** Execute anything; credentials live only in this child and its command descendants. */
export async function runIntegrationCommand(
  command: string[],
  result: IntegrationExecutionEnvironment,
  inherited: NodeJS.ProcessEnv = process.env,
  selection?: IntegrationExecutionSelection
): Promise<number> {
  const child = Bun.spawn(command, {
    env: commandExecutionEnvironment(inherited, result, selection),
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  })
  const interrupt = () => child.kill('SIGINT')
  const terminate = () => child.kill('SIGTERM')
  process.on('SIGINT', interrupt)
  process.on('SIGTERM', terminate)
  try {
    return await child.exited
  } finally {
    process.off('SIGINT', interrupt)
    process.off('SIGTERM', terminate)
  }
}
