import { expect, test } from 'bun:test'
import { notionPlugin } from '../notion/plugin'
import { projectIntegrationAssignments } from './projector'
import { resolveProtectedBindings } from './protected-env'

const connection = {
  id: 'connection',
  providerKey: 'notion',
  adapterVersion: 1,
  configuration: { version: 1, workspaceId: 'workspace-id', workspaceName: null, workspaceIcon: null, botId: 'bot' },
  credentialRef: 'credential-ref',
  materialRevision: 'revision',
}

test('resolves only nonsecret configuration without credential access', async () => {
  const projection = projectIntegrationAssignments([{ plugin: notionPlugin, connection }])
  expect(await resolveProtectedBindings(projection)).toEqual([['NOTION_WORKSPACE_ID', 'workspace-id']])
})

test('invalid configuration fails closed', async () => {
  const missing = projectIntegrationAssignments([
    {
      plugin: notionPlugin,
      connection: { ...connection, configuration: {} },
    },
  ])
  await expect(resolveProtectedBindings(missing)).rejects.toThrow()
})
