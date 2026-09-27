import { Command } from 'commander'
import { apiGet } from '../client'
import { output, outputError } from '../output'

export function registerWebhookCommands(program: Command) {
  const webhook = program.command('webhook').description('Manage webhooks')

  // ficus webhook status <provider>
  webhook
    .command('status <provider>')
    .description('Check webhook provider configuration status')
    .action(async (provider) => {
      try {
        const result = await apiGet<any>(`/api/webhooks/${provider}/status`)
        output(
          result,
          `Provider: ${result.provider}\nRegistered: ${result.registered}\nSecret configured: ${result.secretConfigured}`
        )
      } catch (error) {
        outputError(error as Error)
      }
    })
}
