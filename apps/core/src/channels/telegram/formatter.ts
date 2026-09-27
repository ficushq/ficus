import type { NotificationEvent } from '../provider'

/**
 * Format notification for Telegram using MarkdownV2.
 * Returns text and parse_mode for sendMessage API.
 */
export function formatNotification(event: NotificationEvent): { text: string; parse_mode: string } {
  const lines: string[] = [`*${escapeMarkdown(event.title)}*`, '', escapeMarkdown(event.body)]

  if (event.squadName) {
    lines.push('', `_Squad: ${escapeMarkdown(event.squadName)}_`)
  }

  if (event.url) {
    lines.push('', `[View in Ficus](${event.url})`)
  }

  return {
    text: lines.join('\n'),
    parse_mode: 'MarkdownV2',
  }
}

/**
 * Escape special characters for Telegram MarkdownV2.
 */
function escapeMarkdown(text: string): string {
  return text.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, '\\$&')
}
