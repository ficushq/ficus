import { Command } from 'commander'
import { apiGet, apiPost, apiPut, apiDelete } from '../client'
import { output, outputTable, outputError, isJsonMode } from '../output'

export function registerProviderAuthCommands(program: Command) {
  const auth = program.command('provider-auth').alias('pa').description('Manage AI provider credentials')

  // ficus provider-auth list
  auth
    .command('list')
    .description('List all configured providers')
    .action(async () => {
      try {
        const providers = await apiGet<any[]>('/api/provider-auth')
        if (isJsonMode()) {
          output(providers)
        } else {
          if (providers.length === 0) {
            console.log('No provider credentials configured')
            return
          }
          outputTable(providers, ['provider', 'type', 'hasCredential'])
        }
      } catch (error) {
        outputError(error as Error)
      }
    })

  // ficus provider-auth get <provider>
  auth
    .command('get <provider>')
    .description('Check auth status for a provider')
    .action(async (provider) => {
      try {
        const result = await apiGet<any>(`/api/provider-auth/${provider}`)
        output(result)
      } catch (error) {
        outputError(error as Error)
      }
    })

  // ficus provider-auth set <provider> <key>
  auth
    .command('set <provider> <key>')
    .description('Set an API key for a provider')
    .action(async (provider, key) => {
      try {
        const result = await apiPut<any>(`/api/provider-auth/${provider}`, { key })
        output(result, `Set API key for provider "${provider}"`)
      } catch (error) {
        outputError(error as Error)
      }
    })

  // ficus provider-auth delete <provider>
  auth
    .command('delete <provider>')
    .alias('rm')
    .description('Remove auth for a provider')
    .action(async (provider) => {
      try {
        await apiDelete(`/api/provider-auth/${provider}`)
        output({ provider, deleted: true }, `Removed auth for provider "${provider}"`)
      } catch (error) {
        outputError(error as Error)
      }
    })

  // ficus provider-auth reset <provider> [--account <id>]
  auth
    .command('reset <provider>')
    .description("Clear a provider's exhaustion cooldown (use when its limit window reset early)")
    .option('--account <id>', 'Clear only this account instead of the whole provider')
    .action(async (provider, options) => {
      try {
        const path = options.account
          ? `/api/provider-auth/${provider}/accounts/${options.account}/health/reset`
          : `/api/provider-auth/${provider}/health/reset`
        const result = await apiPost<any>(path)
        const scope = options.account ? `account "${options.account}" of "${provider}"` : `provider "${provider}"`
        output(result, `Reset health for ${scope} — now ${result?.health ?? 'unknown'}`)
      } catch (error) {
        outputError(error as Error)
      }
    })

  // ficus provider-auth oauth-providers
  auth
    .command('oauth-providers')
    .description('List available OAuth providers')
    .action(async () => {
      try {
        const providers = await apiGet<any[]>('/api/provider-auth/oauth/providers')
        if (isJsonMode()) {
          output(providers)
        } else {
          if (providers.length === 0) {
            console.log('No OAuth providers available')
            return
          }
          outputTable(providers, ['id', 'name'])
        }
      } catch (error) {
        outputError(error as Error)
      }
    })
}
