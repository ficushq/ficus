import { Command } from 'commander'
import { apiGet, apiPut, apiPost, apiGetRaw } from '../client'
import { output, outputError } from '../output'

export function registerNotificationConfigCommands(program: Command) {
  const notif = program.command('notification-config').alias('notif').description('Manage notification config')

  // ficus notification-config me — the caller's own notification preferences (self-service)
  notif
    .command('me')
    .description('Show your own notification preferences (push toggle + muted events)')
    .action(async () => {
      try {
        const prefs = await apiGet<{ pushEnabled: boolean; mutedEvents: string[]; pushEvents: string[] }>(
          '/api/notification-config/me'
        )
        output(prefs)
      } catch (error) {
        outputError(error as Error)
      }
    })

  // ficus notification-config set-mine [--push-enabled <bool>] [--muted <events>]
  notif
    .command('set-mine')
    .description('Update your own notification preferences')
    .option('--push-enabled <bool>', 'Enable/disable push for yourself (true|false)')
    .option('--muted <events>', 'Comma-separated event types to mute (replaces the list; empty to clear)')
    .action(async (options) => {
      try {
        const body: { pushEnabled?: boolean; mutedEvents?: string[] } = {}
        if (options.pushEnabled !== undefined) body.pushEnabled = options.pushEnabled === 'true'
        if (options.muted !== undefined) {
          body.mutedEvents = options.muted
            ? options.muted
                .split(',')
                .map((s: string) => s.trim())
                .filter(Boolean)
            : []
        }
        const prefs = await apiPut<{ pushEnabled: boolean; mutedEvents: string[] }>('/api/notification-config/me', body)
        output(prefs, 'Updated your notification preferences')
      } catch (error) {
        outputError(error as Error)
      }
    })

  // ficus notification-config get
  notif
    .command('get')
    .description('Get current notification config')
    .action(async () => {
      try {
        const config = await apiGet<any>('/api/notification-config')
        output(config)
      } catch (error) {
        outputError(error as Error)
      }
    })

  // ficus notification-config set
  notif
    .command('set')
    .description('Update notification config from JSON file')
    .requiredOption('--file <path>', 'Path to JSON file with rules and channels')
    .action(async (options) => {
      try {
        const fs = await import('fs')
        const content = JSON.parse(fs.readFileSync(options.file, 'utf-8'))
        await apiPut('/api/notification-config', content)
        output({ ok: true }, 'Updated notification config')
      } catch (error) {
        outputError(error as Error)
      }
    })

  // ficus notification-config template-diff
  notif
    .command('template-diff')
    .description('Show diff between current config and YAML template')
    .action(async () => {
      try {
        const diff = await apiGet<any>('/api/notification-config/template-diff')
        output(diff)
      } catch (error) {
        outputError(error as Error)
      }
    })

  // ficus notification-config revert
  notif
    .command('revert')
    .description('Revert notification config to YAML template')
    .action(async () => {
      try {
        await apiPost('/api/notification-config/revert-to-template')
        output({ ok: true }, 'Reverted notification config to template')
      } catch (error) {
        outputError(error as Error)
      }
    })

  // ficus notification-config disable
  notif
    .command('disable')
    .description('Disable notification config')
    .action(async () => {
      try {
        await apiPost('/api/notification-config/disable')
        output({ ok: true }, 'Disabled notification config')
      } catch (error) {
        outputError(error as Error)
      }
    })

  // ficus notification-config enable
  notif
    .command('enable')
    .description('Enable notification config')
    .action(async () => {
      try {
        await apiPost('/api/notification-config/enable')
        output({ ok: true }, 'Enabled notification config')
      } catch (error) {
        outputError(error as Error)
      }
    })

  // ficus notification-config export
  notif
    .command('export')
    .description('Export notification config as YAML')
    .action(async () => {
      try {
        const response = await apiGetRaw('/api/notification-config/export')
        const yaml = await response.text()
        console.log(yaml)
      } catch (error) {
        outputError(error as Error)
      }
    })
}
