/**
 * The Discord slash commands Tau registers for its bot. One definition serves
 * the server (which registers them when a Discord connection is saved) and
 * the CLI's diagnostic `ficus discord` commands.
 */

export const DiscordOptionType = { SUB_COMMAND: 1, STRING: 3 } as const

export const FICUS_DISCORD_COMMANDS = [
  {
    name: 'tau',
    description: 'Interact with Tau - your AI development assistant',
    options: [
      {
        name: 'squad',
        description: 'Choose a squad in a private bot conversation',
        type: DiscordOptionType.SUB_COMMAND,
        options: [
          {
            name: 'squad',
            type: DiscordOptionType.STRING,
            required: false,
            description: 'Squad slug, name or ID; omit to list squads',
          },
        ],
      },
      { name: 'status', description: 'Show active work streams across squads', type: DiscordOptionType.SUB_COMMAND },
      {
        name: 'ask',
        description: 'Ask a question or make a request',
        type: DiscordOptionType.SUB_COMMAND,
        options: [
          { name: 'message', type: DiscordOptionType.STRING, required: true, description: 'Your question or request' },
        ],
      },
      {
        name: 'notify',
        description: 'Subscribe this channel to notifications for a squad',
        type: DiscordOptionType.SUB_COMMAND,
        options: [{ name: 'squad', type: DiscordOptionType.STRING, required: true, description: 'Squad name or ID' }],
      },
      {
        name: 'unnotify',
        description: 'Unsubscribe this channel from squad notifications',
        type: DiscordOptionType.SUB_COMMAND,
        options: [{ name: 'squad', type: DiscordOptionType.STRING, required: true, description: 'Squad name or ID' }],
      },
      {
        name: 'link',
        description: 'Link your Discord account to Tau',
        type: DiscordOptionType.SUB_COMMAND,
        options: [
          {
            name: 'code',
            type: DiscordOptionType.STRING,
            required: true,
            description: 'Code from Tau Settings → Account',
          },
        ],
      },
      { name: 'help', description: 'Show available commands and linked squads', type: DiscordOptionType.SUB_COMMAND },
    ],
  },
] as const

/** Where the commands live: one guild (instant) or the application (global, up to an hour to propagate). */
export function discordCommandsPath(applicationId: string, guildId?: string): string {
  return guildId
    ? `/applications/${encodeURIComponent(applicationId)}/guilds/${encodeURIComponent(guildId)}/commands`
    : `/applications/${encodeURIComponent(applicationId)}/commands`
}

/** Guild commands are not available in bot DMs; register a DM-only global copy too. */
export const FICUS_DISCORD_DM_COMMANDS = FICUS_DISCORD_COMMANDS.map((command) => ({ ...command, contexts: [1] }))
