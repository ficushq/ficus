import { Command } from 'commander'
import { apiGet, apiPost, apiPut, apiDelete, apiGetRaw } from '../client'
import { output, outputTable, outputError, isJsonMode } from '../output'

export function registerChannelInstanceCommands(program: Command) {
  const ch = program.command('channel').alias('ch').description('Manage channel instances')

  // ficus channel list
  ch.command('list')
    .description('List all channel instances')
    .action(async () => {
      try {
        const instances = await apiGet<any[]>('/api/channel-instances')
        if (isJsonMode()) {
          output(instances)
        } else {
          if (instances.length === 0) {
            console.log('No channel instances')
            return
          }
          outputTable(
            instances.map((i) => ({
              id: i.id,
              name: i.name,
              provider: i.provider,
              disabled: i.disabled ? '✗' : '✓',
              updatedBy: i.updatedBy,
              drift: i.yamlDrift ? 'yes' : 'no',
            })),
            ['id', 'name', 'provider', 'disabled', 'updatedBy', 'drift']
          )
        }
      } catch (error) {
        outputError(error as Error)
      }
    })

  // ficus channel get <id>
  ch.command('get <id>')
    .alias('info')
    .description('Get channel instance details')
    .action(async (id) => {
      try {
        const inst = await apiGet<any>(`/api/channel-instances/${id}`)
        output(inst)
      } catch (error) {
        outputError(error as Error)
      }
    })

  // ficus channel create
  ch.command('create')
    .description('Create a channel instance')
    .requiredOption('--id <id>', 'Channel instance ID')
    .requiredOption('--name <name>', 'Display name')
    .requiredOption('--provider <provider>', 'Provider (discord, slack, etc.)')
    .option('--config <json>', 'Provider config as JSON')
    .option('--channel-squad-map <json>', 'Channel-to-squad map as JSON')
    .option('--default-squad <squadId>', 'Default squad ID')
    .option(
      '--trusted-channels <json>',
      'Explicit trusted channel IDs as a JSON array; [] requires linked users everywhere'
    )
    .action(async (options) => {
      try {
        const body: Record<string, unknown> = {
          id: options.id,
          name: options.name,
          provider: options.provider,
        }
        if (options.trustedChannels !== undefined) body.trustedChannelIds = JSON.parse(options.trustedChannels)
        if (options.config) body.providerConfig = JSON.parse(options.config)
        if (options.channelSquadMap) body.channelSquadMap = JSON.parse(options.channelSquadMap)
        if (options.defaultSquad) body.defaultSquadId = options.defaultSquad

        const result = await apiPost<any>('/api/channel-instances', body)
        output(result, `Created channel instance "${options.id}"`)
      } catch (error) {
        outputError(error as Error)
      }
    })

  // ficus channel update <id>
  ch.command('update <id>')
    .description('Update a channel instance')
    .option('--name <name>', 'New name')
    .option('--provider <provider>', 'New provider')
    .option('--config <json>', 'Provider config as JSON')
    .option('--channel-squad-map <json>', 'Replace channel-to-squad map as JSON')
    .option('--default-squad <squadId>', 'Default squad ID')
    .option(
      '--trusted-channels <json>',
      'Explicit trusted channel IDs as a JSON array; [] requires linked users everywhere'
    )
    .action(async (id, options) => {
      try {
        const body: Record<string, unknown> = {}
        if (options.name) body.name = options.name
        if (options.provider) body.provider = options.provider
        if (options.trustedChannels !== undefined) body.trustedChannelIds = JSON.parse(options.trustedChannels)
        if (options.config) body.providerConfig = JSON.parse(options.config)
        if (options.channelSquadMap) body.channelSquadMap = JSON.parse(options.channelSquadMap)
        if (options.defaultSquad) body.defaultSquadId = options.defaultSquad

        const result = await apiPut<any>(`/api/channel-instances/${id}`, body)
        output(result, `Updated channel instance "${id}"`)
      } catch (error) {
        outputError(error as Error)
      }
    })

  // ficus channel delete <id>
  ch.command('delete <id>')
    .alias('rm')
    .description('Delete a channel instance')
    .action(async (id) => {
      try {
        await apiDelete(`/api/channel-instances/${id}`)
        output({ id, deleted: true }, `Deleted channel instance "${id}"`)
      } catch (error) {
        outputError(error as Error)
      }
    })

  // ficus channel template-diff <id>
  ch.command('template-diff <id>')
    .description('Show diff between current config and YAML template')
    .action(async (id) => {
      try {
        const diff = await apiGet<any>(`/api/channel-instances/${id}/template-diff`)
        output(diff)
      } catch (error) {
        outputError(error as Error)
      }
    })

  // ficus channel revert <id>
  ch.command('revert <id>')
    .description('Revert channel instance to its YAML template')
    .action(async (id) => {
      try {
        await apiPost(`/api/channel-instances/${id}/revert-to-template`)
        output({ id, reverted: true }, `Reverted channel "${id}" to template`)
      } catch (error) {
        outputError(error as Error)
      }
    })

  // ficus channel disable <id>
  ch.command('disable <id>')
    .description('Disable a channel instance')
    .action(async (id) => {
      try {
        await apiPost(`/api/channel-instances/${id}/disable`)
        output({ id, disabled: true }, `Disabled channel "${id}"`)
      } catch (error) {
        outputError(error as Error)
      }
    })

  // ficus channel enable <id>
  ch.command('enable <id>')
    .description('Enable a channel instance')
    .action(async (id) => {
      try {
        await apiPost(`/api/channel-instances/${id}/enable`)
        output({ id, enabled: true }, `Enabled channel "${id}"`)
      } catch (error) {
        outputError(error as Error)
      }
    })

  // ficus channel export <id>
  ch.command('export <id>')
    .description('Export channel instance as YAML')
    .action(async (id) => {
      try {
        const response = await apiGetRaw(`/api/channel-instances/${id}/export`)
        const yaml = await response.text()
        console.log(yaml)
      } catch (error) {
        outputError(error as Error)
      }
    })
}
