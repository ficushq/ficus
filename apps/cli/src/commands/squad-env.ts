import { Command } from 'commander'
import { apiDelete, apiGet, apiPut } from '../client'
import { output, outputError, isJsonMode, outputTable } from '../output'

export function registerSquadEnvCommands(program: Command) {
  const env = program.command('squad-env').description('Manage squad environment variables')

  // ficus squad-env get <squadId>
  env
    .command('get <squadId>')
    .description('Get .tau/.env content for a squad')
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
    .description('Set .tau/.env content for a squad (use quotes for multi-line)')
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
    .description('Set .tau/.env content from a file')
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

  // ficus squad-env global-secrets
  env
    .command('global-secrets')
    .description('List Secret Store keys globally exposed to all squad sandboxes (no values)')
    .action(async () => {
      try {
        const result = await apiGet<{ globallyExposedSecretKeys: string[] }>(`/api/squads/workspace/env/global-secrets`)
        output(result)
      } catch (error) {
        outputError(error as Error)
      }
    })

  // ficus squad-env expose-global <keys...>
  env
    .command('expose-global <keys...>')
    .description('Admin/operator: append Secret Store keys globally exposed to all squad sandboxes (no values)')
    .action(async (keys: string[]) => {
      try {
        const result = await apiPut<{ success: boolean; globallyExposedSecretKeys: string[] }>(
          `/api/squads/workspace/env/global-secrets`,
          { keys }
        )
        output(result, `Globally exposed ${result.globallyExposedSecretKeys.length} secret(s) to all squads`)
      } catch (error) {
        outputError(error as Error)
      }
    })

  // ficus squad-env unexpose-global <keys...>
  env
    .command('unexpose-global <keys...>')
    .description('Admin/operator: remove Secret Store keys globally exposed to all squad sandboxes (no values)')
    .action(async (keys: string[]) => {
      try {
        const result = await apiDelete<{ success: boolean; globallyExposedSecretKeys: string[] }>(
          `/api/squads/workspace/env/global-secrets`,
          { keys }
        )
        output(result, `Globally exposed ${result.globallyExposedSecretKeys.length} secret(s) to all squads`)
      } catch (error) {
        outputError(error as Error)
      }
    })

  // ficus squad-env secrets <squadId>
  env
    .command('secrets <squadId>')
    .description('List Secret Store keys and whether they are exposed to a squad (no values)')
    .action(async (squadId) => {
      try {
        const result = await apiGet<{
          secrets: Array<{
            key: string
            isSet: boolean
            exposed: boolean
            squadExposed?: boolean
            globallyExposed?: boolean
          }>
        }>(`/api/squads/workspace/${squadId}/env/secrets`)
        if (isJsonMode()) {
          output(result)
        } else {
          outputTable(result.secrets, ['key', 'isSet', 'exposed'])
        }
      } catch (error) {
        outputError(error as Error)
      }
    })

  // ficus squad-env expose-secrets <squadId> <keys...>
  env
    .command('expose-secrets <squadId> <keys...>')
    .description('Admin/operator: append Secret Store keys exposed to this squad sandbox (no values)')
    .action(async (squadId, keys: string[]) => {
      try {
        const result = await apiPut<{ success: boolean; exposedSecretKeys: string[] }>(
          `/api/squads/workspace/${squadId}/env/secrets`,
          { keys }
        )
        output(result, `Exposed ${result.exposedSecretKeys.length} secret(s) to squad ${squadId.slice(0, 8)}`)
      } catch (error) {
        outputError(error as Error)
      }
    })

  // ficus squad-env unexpose-secrets <squadId> <keys...>
  env
    .command('unexpose-secrets <squadId> <keys...>')
    .description('Admin/operator: remove Secret Store keys exposed to this squad sandbox (no values)')
    .action(async (squadId, keys: string[]) => {
      try {
        const result = await apiDelete<{ success: boolean; exposedSecretKeys: string[] }>(
          `/api/squads/workspace/${squadId}/env/secrets`,
          { keys }
        )
        output(result, `Exposed ${result.exposedSecretKeys.length} secret(s) to squad ${squadId.slice(0, 8)}`)
      } catch (error) {
        outputError(error as Error)
      }
    })
}
