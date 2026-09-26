import { Command } from 'commander'
import { apiGet, apiPost, apiPut, apiDelete, apiGetRaw } from '../client'
import { output, outputTable, outputError } from '../output'

interface SquadPreset {
  id: string
  name: string
  description: string | null
  purpose: string | null
  defaultAgents: string[]
  managerInstructions: string | null
}

export function registerSquadPresetCommands(program: Command) {
  const squadPreset = program.command('squad-preset').alias('sp').description('View squad preset definitions')

  squadPreset
    .command('list')
    .description('List all squad presets')
    .action(async () => {
      try {
        const types = await apiGet<SquadPreset[]>('/api/squad-presets')
        outputTable(
          types.map((t) => ({
            id: t.id,
            name: t.name,
            description: t.description ?? '',
            agents: (t.defaultAgents ?? []).join(', '),
          })),
          ['id', 'name', 'description', 'agents']
        )
      } catch (error) {
        outputError(error as Error)
      }
    })

  squadPreset
    .command('get <id>')
    .alias('info')
    .description('Get squad preset details')
    .action(async (id) => {
      try {
        const t = await apiGet<SquadPreset>(`/api/squad-presets/${id}`)
        output(t)
      } catch (error) {
        outputError(error as Error)
      }
    })

  // ficus squad-preset create
  squadPreset
    .command('create')
    .description('Create a new squad preset')
    .requiredOption('--id <id>', 'Squad preset ID')
    .requiredOption('--name <name>', 'Display name')
    .option('--description <desc>', 'Description')
    .option('--purpose <purpose>', 'Purpose')
    .option('--default-agents <agents>', 'Default agent types (comma-separated)')
    .action(async (options) => {
      try {
        const body: Record<string, unknown> = {
          id: options.id,
          name: options.name,
        }
        if (options.description) body.description = options.description
        if (options.purpose) body.purpose = options.purpose
        if (options.defaultAgents) body.defaultAgents = options.defaultAgents.split(',').map((s: string) => s.trim())

        const result = await apiPost<any>('/api/squad-presets', body)
        output(result, `Created squad preset "${options.id}"`)
      } catch (error) {
        outputError(error as Error)
      }
    })

  // ficus squad-preset update <id>
  squadPreset
    .command('update <id>')
    .description('Update a squad preset')
    .option('--name <name>', 'New name')
    .option('--description <desc>', 'New description')
    .option('--purpose <purpose>', 'New purpose')
    .option('--default-agents <agents>', 'Default agent types (comma-separated)')
    .action(async (id, options) => {
      try {
        const body: Record<string, unknown> = {}
        if (options.name) body.name = options.name
        if (options.description) body.description = options.description
        if (options.purpose) body.purpose = options.purpose
        if (options.defaultAgents) body.defaultAgents = options.defaultAgents.split(',').map((s: string) => s.trim())

        const result = await apiPut<any>(`/api/squad-presets/${id}`, body)
        output(result, `Updated squad preset "${id}"`)
      } catch (error) {
        outputError(error as Error)
      }
    })

  // ficus squad-preset delete <id>
  squadPreset
    .command('delete <id>')
    .alias('rm')
    .description('Delete a squad preset')
    .action(async (id) => {
      try {
        await apiDelete(`/api/squad-presets/${id}`)
        output({ id, deleted: true }, `Deleted squad preset "${id}"`)
      } catch (error) {
        outputError(error as Error)
      }
    })

  // ficus squad-preset template-diff <id>
  squadPreset
    .command('template-diff <id>')
    .description('Show diff between current config and YAML template')
    .action(async (id) => {
      try {
        const diff = await apiGet<any>(`/api/squad-presets/${id}/template-diff`)
        output(diff)
      } catch (error) {
        outputError(error as Error)
      }
    })

  // ficus squad-preset revert <id>
  squadPreset
    .command('revert <id>')
    .description('Revert squad preset to its YAML template')
    .action(async (id) => {
      try {
        await apiPost(`/api/squad-presets/${id}/revert-to-template`)
        output({ id, reverted: true }, `Reverted squad preset "${id}" to template`)
      } catch (error) {
        outputError(error as Error)
      }
    })

  // ficus squad-preset disable <id>
  squadPreset
    .command('disable <id>')
    .description('Disable a squad preset')
    .action(async (id) => {
      try {
        await apiPost(`/api/squad-presets/${id}/disable`)
        output({ id, disabled: true }, `Disabled squad preset "${id}"`)
      } catch (error) {
        outputError(error as Error)
      }
    })

  // ficus squad-preset enable <id>
  squadPreset
    .command('enable <id>')
    .description('Enable a squad preset')
    .action(async (id) => {
      try {
        await apiPost(`/api/squad-presets/${id}/enable`)
        output({ id, enabled: true }, `Enabled squad preset "${id}"`)
      } catch (error) {
        outputError(error as Error)
      }
    })

  // ficus squad-preset export <id>
  squadPreset
    .command('export <id>')
    .description('Export squad preset as YAML')
    .action(async (id) => {
      try {
        const response = await apiGetRaw(`/api/squad-presets/${id}/export`)
        const yaml = await response.text()
        console.log(yaml)
      } catch (error) {
        outputError(error as Error)
      }
    })
}
