/** Core returns names from ALL execution declarations, not just the selected/assigned providers. */
export interface IntegrationExecutionEnvironment {
  environment: Record<string, string>
  scrubVariables: string[]
}

export function commandExecutionEnvironment(
  inherited: NodeJS.ProcessEnv,
  result: IntegrationExecutionEnvironment
): NodeJS.ProcessEnv {
  if (!Array.isArray(result.scrubVariables))
    throw new Error('Unsupported integration execution environment contract; update Core and CLI together')
  const environment = { ...inherited }
  for (const name of result.scrubVariables) delete environment[name]
  return { ...environment, ...result.environment }
}

/** Execute anything; credentials live only in this child and its command descendants. */
export async function runIntegrationCommand(
  command: string[],
  result: IntegrationExecutionEnvironment,
  inherited: NodeJS.ProcessEnv = process.env
): Promise<number> {
  const child = Bun.spawn(command, {
    env: commandExecutionEnvironment(inherited, result),
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
