import { describe, expect, test } from 'bun:test'
import { NotionClientError } from '@ficus/shared/oauth-providers/notion/client'
import { assertNotionIdentity } from './identity'

const expected = {
  version: 1 as const,
  workspaceId: 'workspace-1',
  workspaceName: 'Workspace',
  workspaceIcon: null,
  botId: 'bot-1',
}

describe('assertNotionIdentity', () => {
  test('accepts the same workspace and bot reported by a refresh', () => {
    expect(() => assertNotionIdentity(expected, { ...expected, workspaceName: 'Renamed' })).not.toThrow()
  })

  test('rejects malformed persisted expected identity with a sanitized provider error', () => {
    try {
      assertNotionIdentity({ rawDetail: 'persisted-config-SENTINEL' }, expected)
      throw new Error('expected identity mismatch')
    } catch (error) {
      expect(error).toBeInstanceOf(NotionClientError)
      expect((error as NotionClientError).code).toBe('workspace_identity_mismatch')
      expect(String(error)).not.toContain('persisted-config-SENTINEL')
    }
  })

  test('rejects a different workspace or bot with a sanitized provider error', () => {
    for (const reported of [
      { ...expected, workspaceId: 'workspace-2' },
      { ...expected, botId: 'bot-2' },
    ]) {
      try {
        assertNotionIdentity(expected, reported)
        throw new Error('expected identity mismatch')
      } catch (error) {
        expect(error).toBeInstanceOf(NotionClientError)
        expect((error as NotionClientError).code).toBe('workspace_identity_mismatch')
      }
    }
  })
})
