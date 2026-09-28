import { NotionClientError } from '@ficus/shared/oauth-providers/notion/client'
import { parseNotionConfiguration } from '@ficus/shared/oauth-providers/notion/config'

/** Assert that a refreshed grant still belongs to the connection's workspace and bot. */
export function assertNotionIdentity(expected: unknown, reported: unknown): void {
  let persisted
  try {
    persisted = parseNotionConfiguration(expected)
  } catch {
    throw new NotionClientError('workspace_identity_mismatch')
  }
  // Preserve the provider-response parser's existing failure classification.
  const actual = parseNotionConfiguration(reported)
  if (actual.workspaceId !== persisted.workspaceId || actual.botId !== persisted.botId) {
    throw new NotionClientError('workspace_identity_mismatch')
  }
}
