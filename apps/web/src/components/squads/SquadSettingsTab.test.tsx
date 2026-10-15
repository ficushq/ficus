import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { queryKeys } from '../../queryKeys'
import type { SandboxStatus } from '../../api/workspace'
import { SquadSettingsTab } from './SquadSettingsTab'

/**
 * Seed the sandbox status (and the squad the toolchain form reads) into the
 * cache so both useQuery calls resolve synchronously during the static render.
 */
function renderSandboxSection(squadId: string, status?: SandboxStatus): string {
  const queryClient = new QueryClient()
  if (status) queryClient.setQueryData(queryKeys.sandbox.status(squadId), status)
  // Without a resolved permission set, <Can permission="sandbox:logs"> renders
  // its fallback no matter what — every "no Sandbox Logs" assertion would pass
  // vacuously. Grant the permission so their absence means something.
  queryClient.setQueryData(queryKeys.auth.permissions(squadId), {
    permissions: ['sandbox:logs'],
    identity: { type: 'user', userId: 'user-1' },
  })
  queryClient.setQueryData(queryKeys.squads.basic(squadId), {
    id: squadId,
    name: 'Squad',
    purpose: 'test',
    metadata: {},
  })
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={[`/squads/${squadId}?section=sandbox`]}>
      <QueryClientProvider client={queryClient}>
        <SquadSettingsTab
          squadId={squadId}
          name="Squad"
          purpose="test"
          context={null}
          typeContext={null}
          globalCollaborationEnabled={false}
          maxConcurrentWorkStreams={null}
          blockedGraceMinutes={null}
          consultantIdleDormancyDays={null}
          hostWorkspacePath={null}
        />
      </QueryClientProvider>
    </MemoryRouter>
  )
}

describe('SquadSettingsTab sandbox section', () => {
  // On the host runtime there is no sandbox, so the section has nothing to
  // configure: drop the nav item entirely rather than offer a dead end.
  test('host runtime hides the sandbox nav item and its content', () => {
    const html = renderSandboxSection('squad-host-1', { status: 'running', runtime: 'host' })
    expect(html).not.toContain('>Sandbox<')
    expect(html).not.toContain('Sandbox Lifecycle')
    expect(html).not.toContain('Sandbox Logs')
  })

  test('a ?section=sandbox deep link on host opens Workspace', () => {
    const html = renderSandboxSection('squad-host-2', { status: 'running', runtime: 'host' })
    expect(html).toContain('Workspace directory')
    expect(html).toContain('Git commit identity')
  })

  test('docker runtime keeps lifecycle settings and logs under Workspace', () => {
    const html = renderSandboxSection('squad-docker-1', { status: 'running', runtime: 'docker' })
    expect(html).toContain('>Workspace<')
    expect(html).toContain('Sandbox Lifecycle')
    expect(html).toContain('Git commit identity')
    expect(html).toContain('Sandbox Logs')
    expect(html).not.toContain('General Settings')
  })

  // First load: the runtime is not known yet. Mounting the pane anyway opens a
  // log WebSocket the host runtime cannot serve and flashes controls that are
  // about to disappear — so wait for the status to resolve.
  test('an unresolved sandbox status mounts neither the settings pane nor the logs', () => {
    const html = renderSandboxSection('squad-unknown-1')
    expect(html).not.toContain('Sandbox Lifecycle')
    expect(html).not.toContain('Sandbox Logs')
  })
})

function renderSettingsTab(permissions: string[], entry = '/squads/squad-1/settings'): string {
  const queryClient = new QueryClient()
  queryClient.setQueryData(queryKeys.sandbox.status('squad-1'), { status: 'running', runtime: 'docker' })
  queryClient.setQueryData(queryKeys.auth.permissions('squad-1'), {
    permissions,
    identity: { type: 'user', userId: 'user-1' },
  })
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={[entry]}>
      <QueryClientProvider client={queryClient}>
        <SquadSettingsTab
          squadId="squad-1"
          name="Squad"
          purpose="test"
          context={null}
          typeContext={null}
          globalCollaborationEnabled={false}
          maxConcurrentWorkStreams={null}
          blockedGraceMinutes={null}
          consultantIdleDormancyDays={null}
          hostWorkspacePath={null}
        />
      </QueryClientProvider>
    </MemoryRouter>
  )
}

describe('SquadSettingsTab danger zone', () => {
  // squads:delete alone is enough: the Settings tab and its General section are
  // not gated on squads:update, so this stays reachable for a delete-only user.
  test('General ends with the archive block for a user with squads:delete but not squads:update', () => {
    const html = renderSettingsTab(['squads:delete'])
    expect(html).toContain('Danger zone')
    expect(html).toContain('data-setting-target="archive-squad"')
    expect(html).toContain('>Archive squad</button>')
    // Below the General fields and their save controls.
    expect(html.indexOf('>Save</button>')).toBeGreaterThan(-1)
    expect(html.indexOf('>Save</button>')).toBeLessThan(html.indexOf('Danger zone'))
    expect(html.indexOf('Global collaboration')).toBeLessThan(html.indexOf('Danger zone'))
  })

  test('is absent without squads:delete', () => {
    const html = renderSettingsTab(['squads:update', 'squads:read'])
    expect(html).toContain('Global collaboration')
    expect(html).not.toContain('Danger zone')
    expect(html).not.toContain('Archive')
  })

  test('belongs to General only', () => {
    for (const section of ['work', 'context', 'workspace', 'access']) {
      const html = renderSettingsTab(['squads:delete'], `/squads/squad-1/settings?section=${section}`)
      expect(html).not.toContain('Danger zone')
      expect(html).not.toContain('Archive squad')
    }
  })
})

describe('SquadSettingsTab Work section', () => {
  test('the work id and old workflows links both open the Work page', () => {
    for (const section of ['work', 'workflows']) {
      const html = renderSettingsTab(['squads:update'], `/squads/squad-1/settings?section=${section}`)
      expect(html).toContain('Work capacity')
      expect(html).toContain('squad-max-concurrent-work-streams')
      expect(html).not.toContain('id="squad-name"')
    }
  })
})
