import { useState } from 'react'
import { providerLabel, type ModelCatalogEntry, type Agent, type AgentModelApplyResult } from '@ficus/shared'
import { modelSourceLabel } from '../lib/agentModelSource'
import type { AgentTypeConfig, ModelTierConfig } from '../api/config'
import { applyAgentModelNow, updateAgentModelSource } from '../api/agents'
import { AgentSandboxControls } from './AgentSandboxControls'
import { AgentScopesPanel } from './AgentScopesPanel'
import { SquadSandboxStatusCard } from './sandbox/SquadSandboxStatusCard'
import { AmtpMailboxSection } from './AmtpMailboxSection'
import { usePermissions } from '../hooks/usePermissions'
import { Link } from 'react-router'
import { ChevronDownIcon, KeyIcon } from './icons'
import { agentWorkspaceHref, hasPrivateArea } from './workspace/agentPrivateTargets'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { modelCatalogQuery, queries } from '../queryOptions'
import { queryKeys } from '../queryKeys'
import { SegmentedControl } from './SegmentedControl'
import { SelectionPopup } from './ThemedPopup'
import { TierChainEditor } from './ModelChainEditor'
import { useAdjustOnChange } from '../hooks/useAdjustOnChange'
import { formatTokens } from '../lib/format'
import { isCodexModelSpec } from '../lib/modelSpec'
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

function getAgentModelDisplay(
  agent: Agent,
  agentType?: AgentModelTypeInfo | null
): { configuredChain?: string; source?: string; error?: string } {
  // The server's resolution knows the agent's own overrides and its workflow participant's tier.
  const resolution = agent.modelResolution
  if (resolution)
    return {
      configuredChain: resolution.chain.trim() || undefined,
      source: modelSourceLabel(resolution.source),
      error: resolution.error,
    }

  // A list response carries no resolution: infer what it can from the agent and its type.
  const override = agent.modelOverride?.trim()
  if (override) {
    return {
      configuredChain: override,
      source: agent.metadata?.inheritModel === true ? 'Inherited parent chain' : 'Agent model override',
    }
  }
  if (agent.tierOverride) return { source: `Agent tier override: ${agent.tierOverride}` }

  const configuredChain =
    agentType?.resolvedChain?.trim() || agent.configuredModel?.trim() || agentType?.model?.trim() || undefined
  const provenance = agentType?.provenance?.trim()
  const source = provenance?.startsWith('via tier:')
    ? `Agent type tier: ${provenance.slice('via tier:'.length).trim()}`
    : provenance === 'type override'
      ? 'Agent type model'
      : provenance === 'instance default'
        ? 'Instance default'
        : configuredChain
          ? 'Configured model'
          : undefined

  return { configuredChain, source }
}

type ModelSourceMode = 'default' | 'tier' | 'model'

const MODEL_SOURCE_OPTIONS = [
  { value: 'default', label: 'Default', title: "The workflow participant's or agent type's model" },
  { value: 'tier', label: 'Tier', title: "Follow a model tier's current chain" },
  { value: 'model', label: 'Custom model', title: 'An explicit model priority list' },
] as const

const PICKER_CLASS =
  'ficus-button ficus-button-secondary flex min-w-0 items-center justify-between gap-2 rounded-md px-2 py-1.5 text-sm'

function modeOf(agent: Agent): ModelSourceMode {
  if (agent.modelOverride?.trim()) return 'model'
  if (agent.tierOverride) return 'tier'
  return 'default'
}

/**
 * One model source control: Default (the workflow participant's or agent type's model), a model
 * tier, or a custom model priority list. Saving applies from the agent's next turn.
 */
function ModelSourceEditor({ agent, catalog }: { agent: Agent; catalog: ModelCatalogEntry[] }) {
  const queryClient = useQueryClient()
  const { data: allTiers = [] } = useQuery(queries.modelTiers.list())
  const tiers = allTiers.filter((tier) => !tier.disabled || tier.slug === agent.tierOverride)
  const [mode, setMode] = useState<ModelSourceMode>(() => modeOf(agent))
  const [tier, setTier] = useState(agent.tierOverride ?? '')
  const [chain, setChain] = useState(agent.modelOverride ?? '')
  useAdjustOnChange([agent.modelOverride, agent.tierOverride], () => {
    setMode(modeOf(agent))
    setTier(agent.tierOverride ?? '')
    setChain(agent.modelOverride ?? '')
  })

  const chainEntries = chain
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
  const next =
    mode === 'model'
      ? { modelOverride: chainEntries.join(',') || null, tierOverride: null }
      : mode === 'tier'
        ? { modelOverride: null, tierOverride: tier || null }
        : { modelOverride: null, tierOverride: null }
  const incomplete = (mode === 'model' && !next.modelOverride) || (mode === 'tier' && !next.tierOverride)
  const dirty =
    next.modelOverride !== (agent.modelOverride ?? null) || next.tierOverride !== (agent.tierOverride ?? null)

  const save = useMutation({
    mutationFn: () => updateAgentModelSource(agent.id, next),
    onSuccess: (updated) => {
      // Keep the per-caller fields the PATCH response does not carry.
      queryClient.setQueryData<Agent>(queryKeys.agents.detail(agent.id), (previous) => ({
        ...previous,
        ...updated,
        canUpdate: previous?.canUpdate ?? agent.canUpdate,
      }))
      void queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(agent.id) })
    },
  })

  const providers = [...new Set(catalog.map((model) => model.provider))].sort()
  const customTier: ModelTierConfig = {
    slug: 'agent-custom-model',
    label: 'Custom model',
    description: null,
    chain,
    sortOrder: 0,
    usedByCount: 0,
  }

  return (
    <div className="space-y-3" role="group" aria-label="Change model source">
      <SegmentedControl
        ariaLabel="Model source"
        options={MODEL_SOURCE_OPTIONS}
        value={mode}
        onChange={(value) => {
          save.reset()
          setMode(value)
          if (value === 'tier' && !tier) setTier(tiers[0]?.slug ?? '')
          // Start a custom list from what the agent runs now, so it can be reordered or trimmed.
          if (value === 'model' && !chain) setChain(agent.modelResolution?.chain ?? agent.configuredModel ?? '')
        }}
        disabled={save.isPending}
      />
      {mode === 'default' && (
        <p className="text-xs text-muted">Runs its workflow participant&apos;s or agent type&apos;s model.</p>
      )}
      {mode === 'tier' &&
        (tiers.length === 0 ? (
          <p className="text-xs text-muted">No model tiers are available.</p>
        ) : (
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
            <span className="w-28 shrink-0 text-xs text-muted">Model tier</span>
            <SelectionPopup
              label="Model tier"
              value={tier}
              options={tiers.map((option) => ({
                value: option.slug,
                label: option.disabled ? `${option.label} (disabled)` : option.label,
                description: option.description ?? undefined,
              }))}
              onChange={setTier}
              disabled={save.isPending}
              className={PICKER_CLASS}
            >
              <span className="truncate">
                {tiers.find((option) => option.slug === tier)?.label ?? (tier || 'Choose a tier')}
              </span>
              <ChevronDownIcon className="h-3 w-3 shrink-0 text-muted" />
            </SelectionPopup>
          </div>
        ))}
      {mode === 'model' && (
        <TierChainEditor
          tier={customTier}
          catalog={catalog}
          providers={providers}
          disabled={save.isPending}
          onSave={(edited) => setChain(edited.chain)}
        />
      )}
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          className="ficus-button ficus-button-primary px-3 py-1.5 text-sm"
          disabled={!dirty || incomplete || save.isPending}
          onClick={() => save.mutate()}
        >
          {save.isPending ? 'Saving…' : 'Save'}
        </button>
        <span className="text-xs text-muted">
          Applies from the agent&apos;s next turn; a running turn keeps its current model.
        </span>
      </div>
      {save.error && (
        <p role="alert" className="text-xs text-status-danger-600 dark:text-status-danger-400">
          {save.error instanceof Error ? save.error.message : String(save.error)}
        </p>
      )}
    </div>
  )
}

/** Offered while the configured model would select something other than the active one. */
function SwitchNowButton({ agent }: { agent: Agent }) {
  const queryClient = useQueryClient()
  const [result, setResult] = useState<AgentModelApplyResult | null>(null)
  const apply = useMutation({
    mutationFn: () => applyAgentModelNow(agent.id),
    onSuccess: (applied) => {
      setResult(applied)
      void queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(agent.id) })
    },
  })
  const next = agent.modelResolution?.nextSelectedModel
  const pending = !!agent.selectedModel && !!next && next !== agent.selectedModel
  if (!pending && !result && !apply.error) return null
  return (
    <div className="flex flex-wrap items-center gap-3">
      {pending && (
        <>
          <button
            type="button"
            className="ficus-button ficus-button-secondary px-3 py-1.5 text-sm"
            disabled={apply.isPending}
            onClick={() => {
              setResult(null)
              apply.mutate()
            }}
          >
            {apply.isPending ? 'Switching…' : 'Switch now'}
          </button>
          <span className="text-xs text-muted">
            Its next turn switches to <span className="font-mono">{next}</span>. Switch now to use it from the next
            model call, keeping the conversation.
          </span>
        </>
      )}
      {result && (
        <p role="status" className="text-xs text-muted">
          {result.message}
        </p>
      )}
      {apply.error && (
        <p role="alert" className="text-xs text-status-danger-600 dark:text-status-danger-400">
          {apply.error instanceof Error ? apply.error.message : String(apply.error)}
        </p>
      )}
    </div>
  )
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
      <p className="text-sm font-medium text-primary wrap-break-word">{name}</p>
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
  // The chat keeps the agent's detail live; read it here too so usage and the model resolution are current.
  const { data: detail } = useQuery({ ...queries.agents.detail(agent.id) })
  const current = detail ?? agent
  const display = getAgentModelDisplay(current, agentType)
  const usage = current.sessionUsage
  const showCost = !isCodexModelSpec(agentType?.model)

  return (
    <div className="h-full overflow-y-auto bg-surface p-5">
      <div className="mx-auto max-w-3xl space-y-6">
        <div>
          <h3 className="text-base font-semibold text-primary">Agent info</h3>
          <p className="mt-1 text-sm text-muted">Configuration, runtime, and access for this agent.</p>
        </div>
        <section className="border-t border-panel-border pt-5 space-y-4" aria-label="Model configuration">
          <h4 className="text-sm font-semibold text-primary">Model</h4>
          {current.selectedModel && (
            <div className="flex flex-wrap items-start gap-x-6 gap-y-2">
              <span className="w-28 shrink-0 text-xs text-muted">Active model</span>
              <ModelLabel catalog={catalog} model={parseDisplayModelSpec(current.selectedModel)} />
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
          {display.error && (
            <p role="alert" className="text-xs text-status-danger-600 dark:text-status-danger-400">
              {display.error}
            </p>
          )}
          {current.canUpdate && (
            <>
              <ModelSourceEditor agent={current} catalog={catalog} />
              <SwitchNowButton agent={current} />
            </>
          )}
          {(current.selectedModel || display.configuredChain) && (
            <details className="text-xs text-muted">
              <summary className="cursor-pointer py-1 hover:text-primary">Technical details</summary>
              <dl className="mt-2 space-y-3 rounded-lg bg-surface-secondary p-3">
                {current.selectedModel && (
                  <div>
                    <dt>Active model spec</dt>
                    <dd className="mt-1 break-all font-mono">{current.selectedModel}</dd>
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
        {usage && (
          <section className="border-t border-panel-border pt-5 space-y-3" aria-label="Session usage">
            <h4 className="text-sm font-semibold text-primary">Session</h4>
            <dl className="grid grid-cols-[7rem_1fr] gap-x-6 gap-y-2 text-sm">
              {usage.context && (
                <>
                  <dt className="text-xs text-muted pt-0.5">Context used</dt>
                  <dd className="text-primary tabular-nums">
                    {Math.round(usage.context.percent)}%
                    <span className="text-muted">
                      {' '}
                      · {formatTokens(usage.context.tokens)} of {formatTokens(usage.context.contextWindow)}
                    </span>
                  </dd>
                </>
              )}
              <dt className="text-xs text-muted pt-0.5">Tokens</dt>
              <dd className="text-primary tabular-nums">{formatTokens(usage.stats.tokens.total)}</dd>
              <dt className="text-xs text-muted pt-0.5">Messages</dt>
              <dd className="text-primary tabular-nums">{usage.stats.totalMessages}</dd>
              {showCost && (
                <>
                  <dt className="text-xs text-muted pt-0.5">Cost</dt>
                  <dd className="text-primary tabular-nums">${usage.stats.cost.toFixed(2)}</dd>
                </>
              )}
            </dl>
          </section>
        )}
        <div
          role="group"
          aria-label="Sandbox status"
          className="flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-panel-border pt-5"
        >
          <h4 className="ficus-section-title">Sandboxes</h4>
          <AgentSandboxControls agentId={agent.id} compact />
          {agent.squadId && <SquadSandboxStatusCard squadId={agent.squadId} compact />}
          {agent.squadId && hasPrivateArea(agent) && can('agents:private-access') && (
            <Link
              to={agentWorkspaceHref(agent.squadId, agent.id)}
              className="ficus-button ficus-button-ghost inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs"
            >
              <KeyIcon className="h-3.5 w-3.5" /> Open private workspace
            </Link>
          )}
        </div>
        <AmtpMailboxSection agentId={agent.id} squadId={agent.squadId ?? undefined} />
        <AgentScopesPanel agentId={agent.id} />
      </div>
    </div>
  )
}
