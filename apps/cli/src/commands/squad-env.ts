import { Command } from 'commander'
import { apiGet, apiPut } from '../client'
import { output, outputError, isJsonMode } from '../output'

export function registerSquadEnvCommands(program: Command) {
  const env = program.command('squad-env').description('Manage squad environment variables')

  // ficus squad-env get <squadId>
  env
    .command('get <squadId>')
    .description('Get custom env.user content for a squad')
    .action(async (squadId) => {
      try {
        const result = await apiGet<{ content: string }>(`/api/squads/workspace/${squadId}/env`)
        if (isJsonMode()) {
          output(result)
        } else {
          console.log(result.content || '(empty)')
        }
      } catch (error) {
        outputError(error as Error)
      }
    })

  // ficus squad-env set <squadId> <content>
  env
    .command('set <squadId> <content>')
    .description('Set custom env.user content for a squad (use quotes for multi-line)')
    .action(async (squadId, content) => {
      try {
        await apiPut(`/api/squads/workspace/${squadId}/env`, { content })
        output({ success: true }, `Updated env for squad ${squadId.slice(0, 8)}`)
      } catch (error) {
        outputError(error as Error)
      }
    })

  // ficus squad-env set-file <squadId> <path>
  env
    .command('set-file <squadId> <path>')
    .description('Set custom env.user content from a file')
    .action(async (squadId, path) => {
      try {
        const fs = await import('fs')
        const content = fs.readFileSync(path, 'utf-8')
        await apiPut(`/api/squads/workspace/${squadId}/env`, { content })
        output({ success: true }, `Updated env for squad ${squadId.slice(0, 8)} from ${path}`)
      } catch (error) {
        outputError(error as Error)
      }
    })
}
