import { providerLabel, type ModelCatalogEntry, type Agent } from '@ficus/shared'
import type { AgentTypeConfig } from '../api/config'
import { AgentSandboxControls } from './AgentSandboxControls'
import { AgentScopesPanel } from './AgentScopesPanel'
import { SquadSandboxStatusCard } from './sandbox/SquadSandboxStatusCard'
import { AmtpMailboxSection } from './AmtpMailboxSection'
import { ExternalExportControl } from './ExternalExportControl'
import { usePermissions } from '../hooks/usePermissions'
import { useQuery } from '@tanstack/react-query'
import { integrationQueries, modelCatalogQuery } from '../queryOptions'
import {
  parseDisplayModelPriorityList,
  parseDisplayModelSpec,
  type ParsedDisplayModelSpec,
} from '../lib/displayModelSpec'

type AgentModelTypeInfo = Pick<AgentTypeConfig, 'model' | 'tier' | 'resolvedChain' | 'provenance'>

interface AgentInfoPanelProps {
  agent: Agent
  agentType?: AgentModelTypeInfo | null
}

function getAgentModelDisplay(agent: Agent, agentType?: AgentModelTypeInfo | null) {
  const override = agent.modelOverride?.trim()
  if (override) {
    return {
      configuredChain: override,
      source: agent.metadata?.inheritModel === true ? 'Inherited parent chain' : 'Agent override',
    }
  }

  const configuredChain =
    agentType?.resolvedChain?.trim() || agent.configuredModel?.trim() || agentType?.model?.trim() || undefined
  const provenance = agentType?.provenance?.trim()
  const source = provenance?.startsWith('via tier:')
    ? `Model tier: ${provenance.slice('via tier:'.length).trim()}`
    : provenance === 'type override'
      ? 'Agent type override'
      : provenance === 'instance default'
        ? 'Instance default'
        : configuredChain
          ? 'Configured model'
          : undefined

  return { configuredChain, source }
}

function ModelLabel({ model, catalog }: { model: ParsedDisplayModelSpec; catalog: ModelCatalogEntry[] }) {
  const metadata = catalog.find((item) => item.provider === model.provider && item.id === model.modelId)
  const name = metadata?.name ?? model.modelId
  const thinking =
    model.thinkingLevel === 'xhigh'
      ? 'Extra high'
      : model.thinkingLevel
        ? model.thinkingLevel.charAt(0).toUpperCase() + model.thinkingLevel.slice(1)
        : undefined
  return (
    <div className="min-w-0">
      <p className="text-sm font-medium text-primary break-words">{name}</p>
      <p className="mt-0.5 text-xs text-muted">
        {providerLabel(model.provider)}
        {model.provider && thinking && ' · '}
        {thinking && `${thinking} reasoning`}
      </p>
    </div>
  )
}

export function AgentInfoPanel({ agent, agentType }: AgentInfoPanelProps) {
  const { data: catalog = [] } = useQuery(modelCatalogQuery(agent.id))
  const { can } = usePermissions(agent.squadId ?? undefined)
  const canReadIntegrations = can('integrations:read')
  const { data: selection } = useQuery({
    ...integrationQueries.squad(agent.squadId ?? '', 'bigbrain'),
    enabled: Boolean(agent.squadId) && canReadIntegrations,
  })
  const bigbrainConnection = canReadIntegrations && selection?.assignment?.enabled ? selection.assignment : undefined
  const display = getAgentModelDisplay(agent, agentType)

  return (
    <div className="h-full overflow-y-auto bg-surface p-5">
      <div className="mx-auto max-w-3xl space-y-6">
        <div>
          <h3 className="text-base font-semibold text-primary">Agent info</h3>
          <p className="mt-1 text-sm text-muted">Configuration, runtime, and access for this agent.</p>
        </div>
        <section className="border-t border-panel-border pt-5 space-y-4" aria-label="Model configuration">
          <h4 className="text-sm font-semibold text-primary">Model</h4>
          {agent.selectedModel && (
            <div className="flex flex-wrap items-start gap-x-6 gap-y-2">
              <span className="w-28 shrink-0 text-xs text-muted">Active model</span>
              <ModelLabel catalog={catalog} model={parseDisplayModelSpec(agent.selectedModel)} />
            </div>
          )}
          {display.configuredChain && (
            <div className="flex flex-wrap items-start gap-x-6 gap-y-2">
              <span className="w-28 shrink-0 text-xs text-muted">Model priority</span>
              <ol className="min-w-0 space-y-3">
                {parseDisplayModelPriorityList(display.configuredChain).map((model, index) => (
                  <li key={index} className="flex items-start gap-3">
                    <span className="pt-0.5 text-xs tabular-nums text-muted">{index + 1}</span>
                    <ModelLabel catalog={catalog} model={model} />
                  </li>
                ))}
              </ol>
            </div>
          )}
          {display.source && (
            <p className="text-xs text-muted">
              <span>Model source</span> · {display.source}
            </p>
          )}
          {(agent.selectedModel || display.configuredChain) && (
            <details className="text-xs text-muted">
              <summary className="cursor-pointer py-1 hover:text-primary">Technical details</summary>
              <dl className="mt-2 space-y-3 rounded-lg bg-surface-secondary p-3">
                {agent.selectedModel && (
                  <div>
                    <dt>Active model spec</dt>
                    <dd className="mt-1 break-all font-mono">{agent.selectedModel}</dd>
                  </div>
                )}
                {display.configuredChain && (
                  <div>
                    <dt>Configured chain</dt>
                    <dd className="mt-1 break-all font-mono">{display.configuredChain}</dd>
                  </div>
                )}
              </dl>
            </details>
          )}
        </section>
        {/* Conversation export is a per-connection consent surface — with no
            enabled Bigbrain connection on this squad there is nothing to
            consent TO, and rendering the section on an instance that never
            configured the integration was pure confusion. */}
        {agent.squadId && !agent.parentAgentId && bigbrainConnection && (
          <ExternalExportControl
            agentId={agent.id}
            connectionId={bigbrainConnection.id}
            canExport={can('integrations:export')}
          />
        )}
        <div
          role="group"
          aria-label="Sandbox status"
          className="flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-panel-border pt-5"
        >
          <h4 className="ficus-section-title">Sandboxes</h4>
          <AgentSandboxControls agentId={agent.id} compact />
          {agent.squadId && <SquadSandboxStatusCard squadId={agent.squadId} compact />}
        </div>
        <AmtpMailboxSection agentId={agent.id} squadId={agent.squadId ?? undefined} />
        <AgentScopesPanel agentId={agent.id} />
      </div>
    </div>
  )
}
