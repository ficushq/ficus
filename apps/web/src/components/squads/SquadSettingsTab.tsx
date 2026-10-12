import { SQUAD_SETTINGS_SECTIONS as SECTIONS, resolveSquadSettingsSection } from '../../lib/squadNavigation'
import { useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { SquadGeneralSettings } from './SquadGeneralSettings'
import { SquadContextEditor } from './SquadContextEditor'
import { SquadAgentContextEditor } from './SquadAgentContextEditor'
import { SquadSshKeys } from './SquadSshKeys'
import { SquadSshConfig } from './SquadSshConfig'
import { RemoteHostsSettings } from './RemoteHostsSettings'
import { SquadGitIdentitySettings } from './SquadGitIdentitySettings'
import { SquadEnvConfig } from './SquadEnvConfig'
import { MemorySettings } from './MemorySettings'
import { MemorySyncSettings } from './MemorySyncSettings'
import { WorkspaceIndexingSettings } from './WorkspaceIndexingSettings'
import { NotificationSettings } from './NotificationSettings'
import { SandboxSettings } from './SandboxSettings'
import { SandboxLogs } from './SandboxLogs'
import { SandboxProcesses } from '../sandbox/SandboxProcesses'
import { IntegrationSettings } from './IntegrationSettings'
import { DirectMergePolicySettings } from './DirectMergePolicySettings'
import { queries } from '../../queryOptions'
import { Can } from '../Can'
import { SettingsNavigation } from '../settings/SettingsNavigation'
import { SettingsSearchDestination } from '../settings/SettingsSearchDestination'
import { SQUAD_SETTINGS_KEYWORDS, squadSettingsSearchEntries } from './squadSettingsSearch'
import { SquadDangerZone } from './SquadDangerZone'
import { usePermissions } from '../../hooks/usePermissions'

interface Props {
  squadId: string
  name: string
  purpose: string
  context: string | null
  typeContext: Record<string, string> | null
  globalCollaborationEnabled: boolean
  maxConcurrentWorkStreams: number | null
  blockedGraceMinutes: number | null
  hostWorkspacePath: string | null
}

type SectionId = (typeof SECTIONS)[number]['id']

const SECTION_IDS = SECTIONS.map((s) => s.id) as readonly SectionId[]

function isValidSection(value: string | null): value is SectionId {
  return value !== null && SECTION_IDS.includes(value as SectionId)
}

export function SquadSettingsTab({
  squadId,
  name,
  purpose,
  context,
  typeContext,
  globalCollaborationEnabled,
  maxConcurrentWorkStreams,
  blockedGraceMinutes,
  hostWorkspacePath,
}: Props) {
  const [searchParams, setSearchParams] = useSearchParams()
  const sectionParam = resolveSquadSettingsSection(searchParams.get('section'), searchParams.get('setting'))

  const { data: agentTypes } = useQuery(queries.agentTypes.list())

  const { data: sandboxStatus } = useQuery(queries.sandbox.status(squadId))
  const hostRuntime = sandboxStatus?.runtime === 'host'
  const sections = SECTIONS
  const sandboxSectionReady = sandboxStatus !== undefined && !hostRuntime
  const { can, isLoading: permissionsLoading } = usePermissions(squadId)
  const canDeleteSquad = !permissionsLoading && can('squads:delete')
  const activeSection: SectionId = isValidSection(sectionParam) ? sectionParam : 'general'

  const setActiveSection = (section: string, target?: string) => {
    if (!isValidSection(section)) return
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev)
      if (target) next.set('setting', target)
      else next.delete('setting')
      if (section === 'general') {
        next.delete('section')
      } else {
        next.set('section', section)
      }
      return next
    })
  }

  const groups = [
    { label: 'Squad', ids: ['general', 'context', 'workflows'] },
    { label: 'Connections', ids: ['integrations', 'notifications'] },
    { label: 'Workspace', ids: ['workspace', 'memory', 'access'] },
  ].map((group) => ({
    label: group.label,
    items: group.ids.flatMap((id) => sections.filter((section) => section.id === id)),
  }))

  return (
    <div className="h-full min-h-0 flex flex-col md:flex-row gap-4 md:gap-6">
      <SettingsNavigation
        groups={groups}
        activeSection={activeSection}
        onSectionChange={setActiveSection}
        scopeTitle="Squad settings"
        showOnboardingLink={false}
        pageKeywords={SQUAD_SETTINGS_KEYWORDS}
        searchEntries={squadSettingsSearchEntries({ hostRuntime, sandboxSectionReady, canDeleteSquad })}
      />
      <div className="min-w-0 min-h-0 flex-1 overflow-y-auto">
        <SettingsSearchDestination section={activeSection} target={searchParams.get('setting') ?? undefined}>
          {(activeSection === 'general' ||
            activeSection === 'workflows' ||
            (activeSection === 'workspace' && hostRuntime)) && (
            <div className="mb-8">
              <SquadGeneralSettings
                key={activeSection}
                section={activeSection}
                squadId={squadId}
                name={name}
                purpose={purpose}
                globalCollaborationEnabled={globalCollaborationEnabled}
                maxConcurrentWorkStreams={maxConcurrentWorkStreams}
                blockedGraceMinutes={blockedGraceMinutes}
                hostWorkspacePath={hostWorkspacePath}
              />
            </div>
          )}

          {/* Last in General, below its fields and save controls. Gates itself on squads:delete. */}
          {activeSection === 'general' && <SquadDangerZone squadId={squadId} squadName={name} />}

          {activeSection === 'context' && (
            <div className="space-y-8">
              <SquadContextEditor squadId={squadId} context={context} />
              <SquadAgentContextEditor squadId={squadId} typeContext={typeContext} agentTypes={agentTypes ?? []} />
            </div>
          )}

          {activeSection === 'workspace' && sandboxSectionReady && (
            <div className="mb-8 space-y-8">
              <SandboxSettings squadId={squadId} />
              <Can permission="squads:update" squadId={squadId}>
                <SandboxProcesses target={{ kind: 'squad', squadId }} />
              </Can>
              <Can permission="sandbox:logs" squadId={squadId}>
                <SandboxLogs squadId={squadId} />
              </Can>
            </div>
          )}

          {activeSection === 'memory' && (
            <div className="space-y-8">
              <MemorySettings squadId={squadId} />
              <WorkspaceIndexingSettings squadId={squadId} />
              <MemorySyncSettings squadId={squadId} />
            </div>
          )}

          {activeSection === 'workflows' && <DirectMergePolicySettings squadId={squadId} />}

          {activeSection === 'workspace' && (
            <div className="space-y-8">
              <SquadGitIdentitySettings key={squadId} squadId={squadId} />
              <SquadEnvConfig squadId={squadId} />
            </div>
          )}

          {activeSection === 'integrations' && <IntegrationSettings squadId={squadId} />}

          {activeSection === 'notifications' && <NotificationSettings squadId={squadId} />}

          {activeSection === 'access' && (
            <div className="space-y-8">
              <SquadSshKeys squadId={squadId} />
              <SquadSshConfig squadId={squadId} />
              <RemoteHostsSettings squadId={squadId} />
            </div>
          )}
        </SettingsSearchDestination>
      </div>
    </div>
  )
}
