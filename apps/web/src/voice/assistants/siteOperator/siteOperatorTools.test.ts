import { expect, test } from 'bun:test'
import { siteOperatorToolDefinitions } from './siteOperatorTools'

test('the site operator exposes exactly the twelve consolidated tools', () => {
  expect(siteOperatorToolDefinitions.map((tool) => tool.name).sort()).toEqual(
    [
      'answer_question',
      'delegate_task',
      'get_work',
      'mark_read',
      'message_agent',
      'navigate',
      'read_activity',
      'read_inbox',
      'read_squad_files',
      'read_thread',
      'search_ficus',
      'set_subscription',
    ].sort()
  )
})
