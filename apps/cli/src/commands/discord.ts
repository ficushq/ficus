import { Command } from 'commander'
import { outputError } from '../output'

import { FICUS_DISCORD_COMMANDS } from '@ficus/shared/discord-commands'

// The command set is shared with the server, which registers it whenever a
// Discord connection is saved; these CLI commands remain as diagnostics.
const FICUS_COMMANDS = FICUS_DISCORD_COMMANDS

function getDiscordConfig(options: { token?: string; appId?: string; guildId?: string }) {
  const token = options.token || process.env.DISCORD_BOT_TOKEN
  const appId = options.appId || process.env.DISCORD_APPLICATION_ID
  const guildId = options.guildId || process.env.DISCORD_GUILD_ID

  const missing: string[] = []
  if (!token) missing.push('DISCORD_BOT_TOKEN (or --token)')
  if (!appId) missing.push('DISCORD_APPLICATION_ID (or --app-id)')

  if (missing.length > 0) {
    throw new Error(`Missing required config:\n  ${missing.join('\n  ')}`)
  }

  return { token: token!, appId: appId!, guildId }
}

async function clearCommands(token: string, url: string, scope: string): Promise<boolean> {
  console.log(`🗑️  Clearing ${scope} commands...`)

  const response = await fetch(url, {
    method: 'PUT',
    headers: {
      Authorization: `Bot ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify([]),
  })

  if (!response.ok) {
    const error = await response.text()
    console.error(`❌ Failed to clear ${scope} commands (${response.status}):`)
    console.error(error)
    return false
  }

  console.log(`✅ ${scope} commands cleared`)
  return true
}

async function registerCommands(token: string, url: string, scope: string): Promise<void> {
  console.log(`🔄 Registering ${scope} commands...`)

  const response = await fetch(url, {
    method: 'PUT',
    headers: {
      Authorization: `Bot ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(FICUS_COMMANDS),
  })

  if (!response.ok) {
    const error = await response.text()
    throw new Error(`Failed to register commands (${response.status}): ${error}`)
  }

  const result = (await response.json()) as Array<{ name: string; id: string }>

  console.log('✅ Commands registered successfully!\n')
  console.log('Registered commands:')
  for (const cmd of result) {
    console.log(`  /${cmd.name} (ID: ${cmd.id})`)
  }

  if (scope === 'global') {
    console.log('\n⚠️  Note: Global commands may take up to 1 hour to propagate.')
    console.log('   Use --scope guild for faster testing.')
  }
}

export function registerDiscordCommands(program: Command) {
  const discord = program.command('discord').description('Discord bot management')

  // Shared options for Discord commands
  const addDiscordOptions = (cmd: Command) => {
    return cmd
      .option('--token <token>', 'Discord bot token (or DISCORD_BOT_TOKEN env var)')
      .option('--app-id <id>', 'Discord application ID (or DISCORD_APPLICATION_ID env var)')
      .option('--guild-id <id>', 'Discord guild ID for guild-specific commands (or DISCORD_GUILD_ID env var)')
  }

  // ficus discord register
  addDiscordOptions(
    discord
      .command('register')
      .description('Register slash commands with Discord')
      .option('--scope <scope>', 'Command scope: "global" or "guild" (default: guild if guild-id set, else global)')
  ).action(async (options) => {
    try {
      const config = getDiscordConfig(options)

      // Determine scope
      let scope: 'global' | 'guild' = config.guildId ? 'guild' : 'global'
      if (options.scope) {
        if (options.scope !== 'global' && options.scope !== 'guild') {
          throw new Error('--scope must be "global" or "guild"')
        }
        scope = options.scope
        if (scope === 'guild' && !config.guildId) {
          throw new Error('--scope guild requires --guild-id or DISCORD_GUILD_ID')
        }
      }

      const url =
        scope === 'guild'
          ? `https://discord.com/api/v10/applications/${config.appId}/guilds/${config.guildId}/commands`
          : `https://discord.com/api/v10/applications/${config.appId}/commands`

      console.log(`Application ID: ${config.appId}`)
      if (scope === 'guild') {
        console.log(`Guild ID: ${config.guildId}`)
      }
      console.log()

      await registerCommands(config.token, url, scope)
    } catch (error) {
      outputError(error as Error)
    }
  })

  // ficus discord clear
  addDiscordOptions(
    discord
      .command('clear')
      .description('Clear slash commands from Discord')
      .option('--scope <scope>', 'Command scope to clear: "global", "guild", or "all" (default: current scope)')
  ).action(async (options) => {
    try {
      const config = getDiscordConfig(options)

      const globalUrl = `https://discord.com/api/v10/applications/${config.appId}/commands`
      const guildUrl = config.guildId
        ? `https://discord.com/api/v10/applications/${config.appId}/guilds/${config.guildId}/commands`
        : null

      console.log(`Application ID: ${config.appId}`)
      if (config.guildId) {
        console.log(`Guild ID: ${config.guildId}`)
      }
      console.log()

      let success = true
      const scope = options.scope || (config.guildId ? 'guild' : 'global')

      if (scope === 'all') {
        success = (await clearCommands(config.token, globalUrl, 'global')) && success
        if (guildUrl) {
          success = (await clearCommands(config.token, guildUrl, 'guild')) && success
        } else {
          console.log('⚠️  No guild ID set, skipping guild commands')
        }
      } else if (scope === 'global') {
        success = await clearCommands(config.token, globalUrl, 'global')
      } else if (scope === 'guild') {
        if (!guildUrl) {
          throw new Error('--scope guild requires --guild-id or DISCORD_GUILD_ID')
        }
        success = await clearCommands(config.token, guildUrl, 'guild')
      } else {
        throw new Error('--scope must be "global", "guild", or "all"')
      }

      if (!success) {
        process.exit(1)
      }
    } catch (error) {
      outputError(error as Error)
    }
  })

  // ficus discord status
  addDiscordOptions(discord.command('status').description('Show registered slash commands')).action(async (options) => {
    try {
      const config = getDiscordConfig(options)

      console.log(`Application ID: ${config.appId}`)
      if (config.guildId) {
        console.log(`Guild ID: ${config.guildId}`)
      }
      console.log()

      // Fetch global commands
      const globalUrl = `https://discord.com/api/v10/applications/${config.appId}/commands`
      const globalResponse = await fetch(globalUrl, {
        headers: { Authorization: `Bot ${config.token}` },
      })

      if (!globalResponse.ok) {
        throw new Error(`Failed to fetch global commands: ${globalResponse.status}`)
      }

      const globalCommands = (await globalResponse.json()) as Array<{ name: string; id: string }>

      console.log(`Global commands (${globalCommands.length}):`)
      if (globalCommands.length === 0) {
        console.log('  (none)')
      } else {
        for (const cmd of globalCommands) {
          console.log(`  /${cmd.name} (${cmd.id})`)
        }
      }

      // Fetch guild commands if guild ID is set
      if (config.guildId) {
        const guildUrl = `https://discord.com/api/v10/applications/${config.appId}/guilds/${config.guildId}/commands`
        const guildResponse = await fetch(guildUrl, {
          headers: { Authorization: `Bot ${config.token}` },
        })

        if (!guildResponse.ok) {
          throw new Error(`Failed to fetch guild commands: ${guildResponse.status}`)
        }

        const guildCommands = (await guildResponse.json()) as Array<{ name: string; id: string }>

        console.log(`\nGuild commands (${guildCommands.length}):`)
        if (guildCommands.length === 0) {
          console.log('  (none)')
        } else {
          for (const cmd of guildCommands) {
            console.log(`  /${cmd.name} (${cmd.id})`)
          }
        }
      }

      // Warn about duplicates
      if (config.guildId && globalCommands.length > 0) {
        const guildUrl = `https://discord.com/api/v10/applications/${config.appId}/guilds/${config.guildId}/commands`
        const guildResponse = await fetch(guildUrl, {
          headers: { Authorization: `Bot ${config.token}` },
        })
        const guildCommands = (await guildResponse.json()) as Array<{ name: string }>

        const globalNames = new Set(globalCommands.map((c) => c.name))
        const duplicates = guildCommands.filter((c) => globalNames.has(c.name))

        if (duplicates.length > 0) {
          console.log('\n⚠️  Duplicate commands detected!')
          console.log('   The following commands exist in both global and guild scope:')
          for (const cmd of duplicates) {
            console.log(`   - /${cmd.name}`)
          }
          console.log('\n   Users will see these commands twice. Run one of:')
          console.log('   ficus discord clear --scope global  (keep guild only)')
          console.log('   ficus discord clear --scope guild   (keep global only)')
        }
      }
    } catch (error) {
      outputError(error as Error)
    }
  })
}
