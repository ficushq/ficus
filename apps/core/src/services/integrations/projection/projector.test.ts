import { describe, expect, test } from 'bun:test'
import { notionPlugin } from '../notion/plugin'
import { projectIntegrationAssignments } from './projector'

const connection = {
  id: 'connection-TOKEN-SENTINEL',
  providerKey: 'notion',
  adapterVersion: 1,
  configuration: {
    version: 1,
    workspaceId: 'workspace-TOKEN-SENTINEL',
    workspaceName: 'Workspace',
    workspaceIcon: null,
    botId: 'bot-TOKEN-SENTINEL',
  },
  credentialRef: 'credential-TOKEN-SENTINEL',
  materialRevision: 'revision-TOKEN-SENTINEL',
}

describe('projectIntegrationAssignments', () => {
  test('emits the exact fixed Notion public declaration', () => {
    const first = projectIntegrationAssignments([{ plugin: notionPlugin, connection }])
    const second = projectIntegrationAssignments([{ plugin: notionPlugin, connection }])
    expect(first.publicDeclaration).toEqual(second.publicDeclaration)
    expect(first.publicDeclaration).toEqual({
      packages: ['nodejs@24.12.0'],
      setupSteps: notionPlugin.sandbox.setupSteps,
      initHooks: ['export PATH="$DEVBOX_PROJECT_ROOT/npm/bin:$PATH"'],
      readiness: [{ id: 'notion-cli', command: 'ntn --version', expectedSubstring: '0.23.25' }],
      skills: ['notion'],
      extensions: [],
      protectedBindingNames: ['NOTION_WORKSPACE_ID'],
    })
    expect(first.fingerprint).toBe(second.fingerprint)
    expect(JSON.stringify({ declaration: first.publicDeclaration, fingerprint: first.fingerprint })).not.toContain(
      'TOKEN-SENTINEL'
    )
  })

  test('configuration projection needs no credential and has no token resolver', async () => {
    const projection = projectIntegrationAssignments([{ plugin: notionPlugin, connection }])
    expect([...projection.privateMaterial.bindings.keys()]).toEqual(['NOTION_WORKSPACE_ID'])
    expect(await projection.privateMaterial.bindings.get('NOTION_WORKSPACE_ID')?.()).toBe('workspace-TOKEN-SENTINEL')
    expect(JSON.stringify(projection.publicDeclaration)).not.toContain('TOKEN-SENTINEL')
    expect(projection.fingerprint).not.toContain('TOKEN-SENTINEL')
  })

  test('fails closed on conflicting protected bindings and setup step IDs', () => {
    const conflicting = {
      ...notionPlugin,
      key: 'conflict',
      sandbox: {
        ...notionPlugin.sandbox,
        setupSteps: [{ id: 'notion-cli@0.23.25', script: 'different-script' }],
        protectedBindings: [
          { name: 'NOTION_WORKSPACE_ID', source: { kind: 'configuration' as const, field: 'workspaceId' } },
        ],
      },
    }
    expect(() =>
      projectIntegrationAssignments([
        { plugin: notionPlugin, connection },
        { plugin: conflicting, connection: { ...connection, providerKey: 'conflict' } },
      ])
    ).toThrow('setup_step_conflict')

    const bindingOnly = {
      ...conflicting,
      sandbox: { ...conflicting.sandbox, setupSteps: [] },
    }
    expect(() =>
      projectIntegrationAssignments([
        { plugin: notionPlugin, connection },
        { plugin: bindingOnly, connection: { ...connection, providerKey: 'conflict' } },
      ])
    ).toThrow('protected_binding_conflict')
  })
})
