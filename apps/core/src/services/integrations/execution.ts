import type { IntegrationPluginV1 } from './plugin'
import type { AssignedConnectionResolver } from './connection-repository'
import type { OAuthAuthority } from './authorization/authority'
import { parseOAuthCredential } from './authorization/credential-bundle'

type ExecutionPlugin = IntegrationPluginV1<any, any, any>

/** Public names only: includes unassigned/disabled providers so inherited credentials cannot bleed across execs. */
export function executionVariableNames(plugins: readonly ExecutionPlugin[]): string[] {
  return [...new Set(plugins.flatMap((plugin) => Object.keys(plugin.execution?.environment ?? {})))].sort()
}

export class IntegrationExecutionService {
  constructor(
    private readonly dependencies: {
      plugins: readonly ExecutionPlugin[]
      assignments: AssignedConnectionResolver
      readCredential(reference: string): Promise<unknown>
      authority(): OAuthAuthority
      now?: () => Date
    }
  ) {}

  async environment(
    squadId: string,
    providerKey: string,
    connectionId?: string
  ): Promise<Record<string, string> | null> {
    const { dependencies: deps } = this
    const plugin = deps.plugins.find((entry) => entry.key === providerKey)
    if (!plugin?.execution || !plugin.presentation.assignable || plugin.availability?.().available === false)
      return null
    const connection = connectionId
      ? await deps.assignments.getAssignedById?.(squadId, providerKey, connectionId)
      : await deps.assignments.getAssigned(squadId, providerKey)
    const now = (deps.now?.() ?? new Date()).getTime()
    if (
      !connection ||
      connection.squadId !== squadId ||
      connection.providerKey !== providerKey ||
      (connectionId && connection.id !== connectionId) ||
      connection.adapterVersion !== plugin.adapterVersion ||
      !connection.enabled ||
      connection.authState !== 'authenticated' ||
      connection.healthState !== 'healthy' ||
      connection.validatedRevision !== connection.materialRevision ||
      !connection.validationExpiresAt ||
      connection.validationExpiresAt.getTime() <= now ||
      (plugin.authorization.kind === 'oauth2' && connection.clientAuthority !== deps.authority())
    )
      return null
    const raw = await deps.readCredential(connection.credentialRef)
    try {
      const configuration = plugin.connection.parseConfiguration(connection.configuration)
      const credential = plugin.connection.credential.parse(raw)
      if (plugin.authorization.kind === 'oauth2') {
        const oauth = parseOAuthCredential(raw)
        if (oauth.expiresAt !== null && Date.parse(oauth.expiresAt) <= now) return null
      }
      return Object.fromEntries(
        Object.entries(plugin.execution.environment).map(([name, resolve]) => {
          if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error('Invalid execution variable name')
          return [name, resolve({ configuration, credential })]
        })
      )
    } catch {
      // Never include provider material in a refusal or error message.
      return null
    }
  }
}
