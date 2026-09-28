/**
 * Ficus slash command names shared across channel providers (Discord, Slack, Telegram).
 */

/** All known slash command subcommands. Used for parsing user input. */
export const FICUS_SLASH_COMMANDS = ['status', 'help', 'ask', 'squad', 'link', 'notify', 'unnotify'] as const

/**
 * Discord option names for extracting content from slash command subcommands.
 * Used by extractOptionValue — tries each name in order (ask uses 'message', notify/unnotify use 'squad').
 */
export const FICUS_DISCORD_OPTION_NAMES = ['message', 'squad', 'code'] as const

export type TauSlashCommand = (typeof FICUS_SLASH_COMMANDS)[number]

/** Commands that return immediately without consultant/agent. */
export const FICUS_SYNC_COMMANDS = ['status', 'help', 'notify', 'unnotify'] as const

export type TauSyncCommand = (typeof FICUS_SYNC_COMMANDS)[number]

export function isTauSlashCommand(cmd: string): cmd is TauSlashCommand {
  return (FICUS_SLASH_COMMANDS as readonly string[]).includes(cmd)
}

export function isTauSyncCommand(cmd: string): cmd is TauSyncCommand {
  return (FICUS_SYNC_COMMANDS as readonly string[]).includes(cmd)
}

/** The command word users type or mention in chat: `/ficus …`, `@Ficus …`, `ficus …`. */
export const COMMAND_WORD = 'ficus'

/** Text commands also work in bot DMs without provider slash-command registration. */
export function parseDirectCommand(text: string): { command: string; text: string } | null {
  const match = text
    .trim()
    .match(
      new RegExp(
        String.raw`^(?:\/(?:${COMMAND_WORD}(?:@\w+)?\s+)?|@?${COMMAND_WORD}\s+)(squad|help|status|link|ask|notify|unnotify)(?:@\w+)?(?:\s+(.*))?$`,
        'is'
      )
    )
  return match ? { command: match[1].toLowerCase(), text: match[2]?.trim() ?? '' } : null
}
