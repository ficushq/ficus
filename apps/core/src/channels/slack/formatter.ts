import type { NotificationEvent } from '../provider'

interface SlackBlock {
  type: string
  text?: { type: string; text: string; emoji?: boolean }
  elements?: Array<{ type: string; text?: string }>
}

export function formatNotification(event: NotificationEvent): { blocks: SlackBlock[] } {
  // Build body text, include link if URL is set
  let bodyText = event.body
  if (event.url) {
    bodyText += `\n\n<${event.url}|View in Ficus>`
  }

  const blocks: SlackBlock[] = [
    { type: 'header', text: { type: 'plain_text', text: event.title, emoji: true } },
    { type: 'section', text: { type: 'mrkdwn', text: bodyText } },
  ]

  if (event.squadName) {
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `Squad: ${event.squadName}` }],
    })
  }

  return { blocks }
}
