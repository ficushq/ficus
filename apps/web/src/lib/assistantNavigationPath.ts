/** Keep a conversation open when its assistant changes the page behind it.
 * Destination page filters win; unrelated source-page filters never carry over.
 */
export function assistantNavigationPath(path: string, currentPath: string): string {
  const base = 'https://ficus.invalid'
  const current = new URL(currentPath, base)
  const target = new URL(path, base)
  if (target.origin !== base || !['open', 'expanded'].includes(current.searchParams.get('chat') ?? '')) return path
  if (
    target.searchParams.has('chat') ||
    target.searchParams.has('assistantConversation') ||
    target.searchParams.has('commandStack')
  )
    return path
  for (const key of [
    'chat',
    'commandStack',
    'commandQuery',
    'assistantConversation',
    'assistantChat',
    'agentConversation',
  ]) {
    const value = current.searchParams.get(key)
    if (value !== null) target.searchParams.set(key, value)
  }
  return `${target.pathname}${target.search}${target.hash}`
}
