/** Opens a saved Assistant conversation on the current page; the navigation reader picks it up. */
export function assistantConversationSearch(search: string, conversationId: string, taskId?: string): string {
  const params = new URLSearchParams(search)
  for (const key of ['commandStack', 'commandQuery', 'assistantChat']) params.delete(key)
  params.set('chat', 'open')
  params.set('assistantConversation', conversationId)
  if (taskId) params.set('assistantTask', taskId)
  else params.delete('assistantTask')
  return params.toString()
}
