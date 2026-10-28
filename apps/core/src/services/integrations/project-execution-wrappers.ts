import { githubCommandBindings } from './github/command-bindings'
import { DbIntegrationConnectionRepository } from './db-connection-repository'
import { firstPartyIntegrationPlugins } from './first-party-plugins'
import { writeExecutionWrappers, type ExecutionWrapper } from './execution-wrappers'

/** Assignment projection uses no credentials. Health is checked fresh by exec, not baked into files. */
export async function projectExecutionWrappers(
  squadId: string,
  directory: string,
  signingPublicKey?: string
): Promise<void> {
  const assignments = new DbIntegrationConnectionRepository()
  const wrappers: ExecutionWrapper[] = []
  for (const plugin of firstPartyIntegrationPlugins) {
    if (
      !plugin.execution?.binaries.length ||
      !plugin.presentation.assignable ||
      plugin.availability?.().available === false
    )
      continue
    const attached = await assignments.listAssigned(squadId, plugin.key)
    if (!attached.some((connection) => connection.enabled && connection.adapterVersion === plugin.adapterVersion))
      continue
    for (const binary of plugin.execution.binaries) wrappers.push({ binary, providerKey: plugin.key })
  }
  writeExecutionWrappers(directory, wrappers, squadId, githubCommandBindings(squadId, signingPublicKey))
}
