/** Display-only summaries. Keep the complete tool result in history and in model context. */
export function summarizeAssistantError(message: string): string {
  if (/<(?:!doctype|html|head|body)\b/i.test(message)) {
    const status = message.match(/\b[45]\d{2}\b/)?.[0]
    return `Ficus is temporarily unavailable${status ? ` (${status})` : ''}. Please try again shortly.`
  }
  const detail = message.replace(/^API error: \d+:\s*/, '')
  try {
    const issues: unknown = JSON.parse(detail)
    if (Array.isArray(issues) && issues.length && issues.every((issue) => typeof issue?.message === 'string')) {
      return 'The edit could not be applied. The assistant received validation details to correct it.'
    }
  } catch {
    // Ordinary error text, not structured validation details.
  }
  return message.length > 300 ? `${message.slice(0, 300)}…` : message
}
