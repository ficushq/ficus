import { useEffect, useRef, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import clsx from 'clsx'
import type { ProviderHealthKind } from '@ficus/shared'
import { queries } from '../../queryOptions'
import { queryKeys } from '../../queryKeys'
import {
  setProviderApiKey,
  addProviderAccount,
  updateProviderAccount,
  deleteProviderAccount,
  reorderProviderAccounts,
  startOAuthFlow,
  cancelOAuthFlow,
  completeOAuthFlow,
  selectOAuthOption,
  type OAuthNeed,
  type ProviderAuthEntry,
  type ClaudeCodeStatus,
  type ProviderCatalogEntry,
  type ProviderAccountEntry,
  detectCompatibleServers,
  probeCompatibleProvider,
  addCompatibleProvider,
  deleteProviderAuth,
  type CompatibleProbeResult,
  type OpenRouterRoutingSummary,
  setOpenRouterRoutingEnabled,
  resetProviderHealth,
} from '../../api/providerAuth'
import {
  extractOAuthCode,
  formatRetryIn,
  healthReasonLabel,
  isCredentialHealthReason,
  invalidateProviderRoutingQueries,
  providerActivityRank,
  selectableProviders,
} from './providerAuthUtils'
import { usePermissions } from '../../hooks/usePermissions'
import { getModelTiers, updateModelTier, type ModelTierConfig } from '../../api/config'
import { assignCompatibleProvider, withTierPosition } from './modelTierUi'
import { useLoadingShapeCount } from '../../hooks/useLoadingShapeCount'
import { CollectionSkeleton, SkeletonLine } from '../loading/Skeleton'
import { ProviderAccountActions } from './ProviderAccountActions'
import { ProviderDirectoryCard } from './ProviderDirectoryCard'
import { ClaudeCodeAccountSetup } from './ClaudeCodeAccountSetup'
import { SearchIcon } from '../icons'
import { OnboardingProviderPicker } from '../onboarding/OnboardingProviderPicker'

/**
 * Known providers with display info.
 * OAuth-capable providers include oauthId to match against the OAuth providers list.
 */
const PROVIDER_REGISTRY: readonly ProviderDefinition[] = [
  {
    id: 'anthropic',
    name: 'Anthropic',
    description: 'Claude models (Sonnet, Opus, Haiku)',
  },
  {
    id: 'openai',
    name: 'OpenAI',
    description: 'GPT and o-series models',
    oauthId: 'openai-codex',
    oauthLabel: 'ChatGPT Plus/Pro',
  },
  {
    id: 'google',
    name: 'Google',
    description: 'Gemini models',
    oauthId: 'gemini-cli',
    oauthLabel: 'Google Cloud',
  },
  {
    id: 'github-copilot',
    name: 'GitHub Copilot',
    description: 'GitHub Copilot subscription models',
    oauthId: 'github-copilot',
    oauthLabel: 'GitHub Copilot',
  },
  {
    id: 'google-antigravity',
    name: 'Google Antigravity',
    description: 'Claude, GPT, Gemini via Google Cloud',
    oauthId: 'google-antigravity',
    oauthLabel: 'Antigravity',
  },
]

type ProviderDefinition = {
  id: string
  name: string
  description: string
  oauthId?: string
  oauthLabel?: string
}

type ProviderCard = {
  provider: ProviderDefinition
  entry?: ProviderAuthEntry
  oauthEntry?: ProviderAuthEntry
  oauthAvailable: boolean
  rank: 0 | 1 | 2
}

export function ProviderAuthSection({ onboarding = false }: { onboarding?: boolean }) {
  const { data: providers = [], isLoading } = useQuery({
    ...queries.providerAuth.list(),
    // Surface recovery without spamming: poll only while a provider is exhausted.
    refetchInterval: (query) => {
      const data = query.state.data
      return data?.some((p) => p.health === 'exhausted') ? 15000 : false
    },
  })
  const loadingCardCount = useLoadingShapeCount(
    'settings:providers',
    isLoading ? undefined : Math.max(PROVIDER_REGISTRY.length, providers.length),
    { fallbackCount: 6, maxCount: 10 }
  )
  const { data: oauthProviders = [] } = useQuery(queries.providerAuth.oauthProviders())
  const { can, isLoading: permissionsLoading } = usePermissions()
  const canWriteProviderAuth = !permissionsLoading && can('provider-auth:write')
  const { data: catalog = [] } = useQuery(queries.providerAuth.catalog())
  const { data: openRouterRouting } = useQuery(queries.providerAuth.openRouterRouting())
  // Claude Code is offered wherever Core runs on the user's own machine (never Ficus Cloud).
  const { data: claudeCodeStatus } = useQuery(queries.providerAuth.claudeCode())
  const claudeCode = claudeCodeStatus?.offered ? claudeCodeStatus : undefined

  const [search, setSearch] = useState('')
  const [selectedProvider, setSelectedProvider] = useState('')
  const providerMap = new Map(providers.map((p) => [p.provider, p]))
  const oauthSet = new Set(oauthProviders.map((p) => p.id))

  if (isLoading) {
    return <CollectionSkeleton label="Loading providers" count={loadingCardCount} layout="cards" />
  }

  const knownProviderIds = new Set(
    PROVIDER_REGISTRY.flatMap((provider) => [provider.id, provider.oauthId].filter(Boolean) as string[])
  )
  const providerCards: ProviderCard[] = [
    ...PROVIDER_REGISTRY.map((registered) => {
      const provider =
        registered.id === 'anthropic' && claudeCode
          ? {
              ...registered,
              name: 'Anthropic / Claude Code',
              description: 'Claude models with an API key, or through Claude Code on your own Claude plan',
            }
          : registered
      const entry = providerMap.get(provider.id)
      const oauthEntry =
        provider.oauthId && provider.oauthId !== provider.id ? providerMap.get(provider.oauthId) : undefined
      return {
        provider,
        entry,
        oauthEntry,
        oauthAvailable: !!provider.oauthId && oauthSet.has(provider.oauthId),
        rank: providerActivityRank([entry, oauthEntry]),
      }
    }),
    ...providers
      .filter((provider) => provider.provider !== 'openrouter' && !knownProviderIds.has(provider.provider))
      .map((entry) => ({
        provider: {
          id: entry.provider,
          name: entry.provider,
          description: 'Custom provider',
        },
        entry,
        oauthAvailable: false,
        rank: providerActivityRank([entry]),
      })),
  ].sort((a, b) => a.rank - b.rank)

  const additionalProviderOptions = selectableProviders(
    catalog,
    new Set([...knownProviderIds, 'openrouter', ...providers.map((provider) => provider.provider)])
  )
  const directoryCards = [
    ...providerCards,
    ...additionalProviderOptions.map(
      (item): ProviderCard => ({
        provider: { id: item.id, name: item.label, description: `${item.modelCount} models available via API key.` },
        oauthAvailable: false,
        rank: 2,
      })
    ),
  ]
  const matches = (text: string) => text.toLowerCase().includes(search.trim().toLowerCase())
  const directory = directoryCards.map((card) => ({
    id: card.provider.id,
    name: card.provider.name,
    description: card.provider.description,
    connected: card.rank < 2,
    status: card.rank === 0 ? 'Connected' : card.rank === 1 ? 'Inactive' : 'Not configured',
    content: (
      <ProviderRow
        provider={card.provider}
        entry={card.entry}
        oauthEntry={card.oauthEntry}
        oauthAvailable={card.oauthAvailable}
        claudeCode={card.provider.id === 'anthropic' ? claudeCode : undefined}
        canWrite={canWriteProviderAuth}
        setup={onboarding}
      />
    ),
  }))
  if (openRouterRouting)
    directory.push({
      id: 'openrouter',
      name: 'OpenRouter',
      description: 'One account for many models, with an optional universal fallback across model tiers.',
      connected: providerActivityRank([providerMap.get('openrouter')]) < 2,
      status: openRouterRouting.active ? 'Connected' : openRouterRouting.configured ? 'Inactive' : 'Not configured',
      content: (
        <OpenRouterSection
          entry={providerMap.get('openrouter')}
          routing={openRouterRouting}
          canWrite={canWriteProviderAuth}
        />
      ),
    })
  const commonProviders = ['openai', 'anthropic', 'openrouter', 'zai', 'z-ai', 'xai', 'deepseek', 'groq']
  const priority = (id: string) => {
    const index = commonProviders.indexOf(id)
    return index < 0 ? commonProviders.length : index
  }
  const visible = directory
    .sort((a, b) => priority(a.id) - priority(b.id) || a.name.localeCompare(b.name))
    .filter((item) => matches(`${item.id} ${item.name} ${item.description} ${item.status}`))

  if (onboarding) {
    const selected = directory.find((item) => item.id === selectedProvider)
    return (
      <div className="space-y-4">
        <OnboardingProviderPicker
          options={[
            ...directory.map(({ id, name, description }) => ({ id, name, description })),
            ...(canWriteProviderAuth
              ? [
                  {
                    id: 'custom',
                    name: 'Local or custom provider',
                    description: 'Ollama, LM Studio, vLLM, or another OpenAI-compatible server.',
                  },
                ]
              : []),
          ]}
          value={selectedProvider}
          onChange={setSelectedProvider}
        />
        {selected && (
          <div key={selected.id} className="pt-1">
            {selected.content}
          </div>
        )}
        {selectedProvider === 'custom' && <CompatibleProviderSetup canWrite={canWriteProviderAuth} />}
        {!canWriteProviderAuth && (
          <p className="text-sm text-muted">Provider setup requires permission to manage AI providers.</p>
        )}
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <header>
        <h3 className="text-lg font-semibold text-primary">AI Providers</h3>
        <p className="mt-1 text-sm text-muted">Connect your AI subscriptions, API accounts, and local models.</p>
      </header>
      <div className="relative">
        <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-muted">
          <SearchIcon className="h-4 w-4" />
        </span>
        <input
          type="search"
          aria-label="Search AI providers"
          placeholder="Search providers…"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          className="ficus-field w-full rounded-lg border border-panel-border bg-surface py-2.5 pl-10 pr-3 text-sm text-primary"
        />
      </div>
      {([true, false] as const).map((connected) => {
        const items = visible.filter((item) => item.connected === connected)
        if (!items.length) return null
        return (
          <section
            key={String(connected)}
            aria-label={connected ? 'Connected providers' : 'Disconnected providers'}
            className="space-y-3"
          >
            <h4 className="text-sm font-medium text-secondary">
              {connected ? 'Connected' : 'Disconnected'} <span className="ml-1 text-muted">{items.length}</span>
            </h4>
            <div className="grid items-stretch gap-4 md:grid-cols-2">
              {items.map((item) => (
                <ProviderDirectoryCard
                  key={item.id}
                  providerId={item.id}
                  name={item.name}
                  description={item.description}
                  status={item.status}
                >
                  {item.content}
                </ProviderDirectoryCard>
              ))}
            </div>
          </section>
        )
      })}
      {visible.length === 0 && (
        <p role="status" className="text-sm text-muted">
          No providers match “{search}”.
        </p>
      )}
      <div className="grid items-stretch gap-4 md:grid-cols-2">
        {canWriteProviderAuth && (
          <ProviderDirectoryCard
            providerId="custom"
            name="Add custom provider"
            description="Connect Ollama, LM Studio, vLLM, or another local or OpenAI-compatible server."
            action="Add provider"
          >
            <CompatibleProviderSetup canWrite={canWriteProviderAuth} />
          </ProviderDirectoryCard>
        )}
      </div>
      <p className="text-xs text-muted">
        Model tiers choose provider order. Enabled accounts are tried from top to bottom, followed by the OpenRouter
        fallback when enabled.
      </p>
    </div>
  )
}

export function OpenRouterSection({
  entry,
  routing,
  canWrite,
}: {
  entry?: ProviderAuthEntry
  routing: OpenRouterRoutingSummary
  canWrite: boolean
}) {
  const queryClient = useQueryClient()
  const mutation = useMutation({
    mutationFn: (enabled: boolean) => setOpenRouterRoutingEnabled(enabled),
    onSuccess: () => {
      return invalidateProviderRoutingQueries(queryClient)
    },
  })
  return (
    <section className="overflow-hidden" aria-labelledby="openrouter-heading">
      <div className={clsx(routing.enabled && 'mb-4 border-b border-panel-border pb-4')}>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h4 id="openrouter-heading" className="text-sm font-medium text-primary">
                Universal fallback
              </h4>
            </div>
            <p className="mt-0.5 text-xs text-muted">
              Covers every model tier after direct provider accounts have been tried.
            </p>
          </div>
          <label className="flex shrink-0 items-center gap-2 text-sm font-medium text-primary">
            <span>Use OpenRouter</span>
            <input
              type="checkbox"
              role="switch"
              aria-label="Use OpenRouter"
              checked={routing.enabled}
              disabled={!canWrite || mutation.isPending}
              onChange={(event) => mutation.mutate(event.target.checked)}
              className="h-4 w-4 accent-current"
            />
          </label>
        </div>
        {routing.enabled && !routing.active && (
          <p className="mt-2 text-xs text-warning" role="status">
            Routing is enabled but waits for an authenticated, enabled OpenRouter account.
          </p>
        )}
        {routing.enabled && (
          <div className="mt-3 grid gap-2 sm:grid-cols-2 text-xs">
            <div className="border-b border-panel-border last:border-b-0 p-2">
              <span className="font-medium text-secondary">Backed vendors (read-only)</span>
              <p className="mt-1 text-muted">
                {routing.active ? routing.vendors.map(providerDisplayName).join(', ') || 'None' : 'None'}
              </p>
            </div>
            <div className="border-b border-panel-border last:border-b-0 p-2">
              <span className="font-medium text-secondary">Backed tiers (read-only)</span>
              <p className="mt-1 text-muted">
                {routing.active
                  ? routing.tiers
                      .filter((tier) => tier.fallbacks.length)
                      .map((tier) => tier.label)
                      .join(', ') || 'None'
                  : 'None'}
              </p>
            </div>
          </div>
        )}
      </div>
      {routing.enabled && (
        <ProviderRow
          provider={{
            id: 'openrouter',
            name: 'OpenRouter account',
            description: 'API key used by authored OpenRouter models and universal fallbacks.',
          }}
          entry={entry}
          oauthAvailable={false}
          canWrite={canWrite}
        />
      )}
    </section>
  )
}

function providerDisplayName(provider: string): string {
  if (provider === 'openai') return 'OpenAI'
  if (provider === 'z-ai') return 'Z.ai'
  return provider.charAt(0).toUpperCase() + provider.slice(1)
}

export function AddProviderSection({ options }: { options: ProviderCatalogEntry[] }) {
  const queryClient = useQueryClient()
  const [selected, setSelected] = useState('')

  if (options.length === 0) return null

  const invalidate = () => invalidateProviderRoutingQueries(queryClient)

  return (
    <div className="border-b border-panel-border last:border-b-0 overflow-hidden">
      <div className="px-4 py-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0 flex-1">
            <h4 data-setting-target="add-a-provider" className="text-sm font-medium text-primary">
              Add a provider
            </h4>
            <p className="mt-0.5 text-xs text-muted">
              Configure an API key for another supported provider, such as Z.ai or Together.
            </p>
          </div>
          <select
            aria-label="Select a provider"
            value={selected}
            onChange={(e) => setSelected(e.target.value)}
            className="ficus-field w-full shrink-0 rounded border border-th-border bg-surface-secondary px-2.5 py-1 text-xs font-medium text-accent-light  focus:ring-1 focus:ring-accent sm:w-auto sm:max-w-xs"
          >
            <option value="">Select a provider…</option>
            {options.map((provider) => (
              <option key={provider.id} value={provider.id}>
                {provider.label}
                {provider.modelCount > 0 ? ` (${provider.modelCount} models)` : ''}
              </option>
            ))}
          </select>
        </div>

        {selected && (
          <div className="border-b border-panel-border last:border-b-0 mt-3 p-3">
            <ApiKeyForm
              providerId={selected}
              onDone={() => {
                setSelected('')
                invalidate()
              }}
              onCancel={() => setSelected('')}
            />
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * Muted trailing detail for an exhausted record: `· plan limit · retry ~30m`.
 * Both halves are optional — a record may carry no reason or no reset — so the
 * row degrades to a bare status rather than printing empty separators.
 */
function healthDetail(reason: ProviderHealthKind | undefined, retryAt: number | undefined): string | null {
  const retryIn = formatRetryIn(retryAt)
  const parts = [healthReasonLabel(reason), retryIn ? `retry ${retryIn}` : null].filter(Boolean) as string[]
  return parts.length ? parts.map((part) => `\u00b7 ${part}`).join(' ') : null
}

/**
 * Provider-level status for one account group.
 *
 * Only shown for state the account rows do NOT already carry: a globally
 * disabled provider, or a provider-wide exhaustion record with no exhausted
 * account behind it. Otherwise this renders nothing, so exhaustion is announced
 * exactly once, on the row that owns it.
 */
function ProviderGroupStatus({
  entry,
  suffix,
  canWrite,
}: {
  entry: ProviderAuthEntry
  suffix: string
  canWrite: boolean
}) {
  const queryClient = useQueryClient()
  const resetMutation = useMutation({
    mutationFn: () => resetProviderHealth(entry.provider),
    onSuccess: () => invalidateProviderRoutingQueries(queryClient),
  })
  const accountExhausted = entry.accounts?.some((account) => account.health === 'exhausted') ?? false
  const exhausted = entry.health === 'exhausted' && !accountExhausted
  if (!entry.disabled && !exhausted) return null
  const detail = healthDetail(entry.healthReason, entry.retryAt)
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      {entry.disabled && (
        <span className="rounded bg-status-neutral-200 px-1.5 py-0.5 text-status-neutral-600 dark:bg-status-neutral-700 dark:text-status-neutral-300">
          Disabled{suffix}
        </span>
      )}
      {exhausted && (
        <>
          <span className="rounded bg-status-attention-100 px-1.5 py-0.5 text-status-attention-700 dark:bg-status-attention-900/30 dark:text-status-attention-400">
            Exhausted{suffix}
          </span>
          {detail && <span className="text-muted">{detail}</span>}
          {canWrite &&
            (isCredentialHealthReason(entry.healthReason) ? (
              <span className="text-muted">Re-authorize to clear</span>
            ) : (
              <button
                onClick={() => resetMutation.mutate()}
                disabled={resetMutation.isPending}
                aria-label={`Reset health for ${entry.provider}`}
                className="ficus-button hover:text-primary disabled:opacity-50"
              >
                Reset
              </button>
            ))}
        </>
      )}
    </div>
  )
}

export function ProviderRow({
  provider,
  entry,
  oauthEntry,
  oauthAvailable,
  claudeCode,
  canWrite = true,
  setup = false,
}: {
  setup?: boolean
  /** Claude Code status, for the Anthropic card where it is offered. */
  claudeCode?: ClaudeCodeStatus
  provider: {
    id: string
    name: string
    description: string
    oauthId?: string
    oauthLabel?: string
  }
  entry?: ProviderAuthEntry
  /**
   * Auth entry for the provider's separate OAuth backend provider id (e.g.
   * openai-codex, gemini-cli) when it differs from the primary id. Rendered on
   * the same card as `entry`; the two are independently manageable.
   */
  oauthEntry?: ProviderAuthEntry
  oauthAvailable: boolean
  canWrite: boolean
}) {
  const queryClient = useQueryClient()
  // Account management is a single generic "Add account" flow: closed, a
  // chooser between API key / OAuth (only when OAuth is available), or one
  // of the two add flows themselves.
  // Claude Code can be connected while its account is absent or turned off.
  const claudeCodeConnectable =
    !!claudeCode && !entry?.accounts?.some((account) => account.kind === 'claude-code' && account.enabled)
  const hasChoice = oauthAvailable || claudeCodeConnectable
  const [addMode, setAddMode] = useState<'closed' | 'choose' | 'api-key' | 'oauth' | 'oauth-browser' | 'claude-code'>(
    () =>
      setup && canWrite && !entry?.hasCredential && !oauthEntry?.hasCredential
        ? hasChoice
          ? 'choose'
          : 'api-key'
        : 'closed'
  )
  const entries = [entry, oauthEntry].filter((e): e is ProviderAuthEntry => !!e)
  const configuredEntries = entries.filter((e) => e.hasCredential)
  // Disambiguate per-entry status badges when both entries are configured.
  const entrySuffix = (e: ProviderAuthEntry) =>
    configuredEntries.length > 1 ? (e === oauthEntry ? ' (OAuth)' : ' (API)') : ''

  const invalidate = () => invalidateProviderRoutingQueries(queryClient)

  const closeAdd = () => {
    setAddMode('closed')
    invalidate()
  }

  // Each backend group renders its own account rows (reorder/mutations stay
  // scoped to that group's provider id) but the two groups are stacked in one
  // continuous, un-titled list section rather than two separate cards.
  const accountGroups = entries.filter((e) => e.accounts && e.accounts.length > 0)
  const hasAnyAccounts = accountGroups.length > 0

  return (
    <div className="space-y-4">
      {entries
        .filter((e) => !accountGroups.includes(e))
        .map((e) => (
          <ProviderGroupStatus key={e.provider} entry={e} suffix={entrySuffix(e)} canWrite={canWrite} />
        ))}
      {canWrite && !hasAnyAccounts && addMode === 'closed' && (
        <button
          onClick={() => setAddMode(hasChoice ? 'choose' : 'api-key')}
          className="ficus-button ficus-button-primary rounded-lg px-3 py-2 text-sm"
        >
          Connect account
        </button>
      )}
      {!canWrite && !hasAnyAccounts && <p className="text-sm text-muted">No accounts connected.</p>}

      {(hasAnyAccounts || addMode !== 'closed') && (
        <div className="space-y-4">
          {configuredEntries.length > 1 && (
            <p className="text-xs text-muted">
              API-key and OAuth accounts for this provider run as separate backends; order applies within each type.
            </p>
          )}

          {accountGroups.map((e) => (
            <div key={e.provider} className="space-y-2">
              <ProviderGroupStatus entry={e} suffix={entrySuffix(e)} canWrite={canWrite} />
              <ProviderAccountsList
                providerId={e.provider}
                accounts={e.accounts!}
                canWrite={canWrite}
                oauthLabel={provider.oauthLabel ?? provider.name}
                claudeCode={claudeCode}
              />
            </div>
          ))}
          {canWrite && hasAnyAccounts && addMode === 'closed' && (
            <button
              onClick={() => setAddMode(hasChoice ? 'choose' : 'api-key')}
              className="ficus-button text-sm text-accent-light hover:text-link-hover"
            >
              Connect another account
            </button>
          )}

          {canWrite && addMode === 'choose' && (
            <AddAccountChooser
              oauthLabel={provider.oauthLabel ?? provider.name}
              onChooseApiKey={() => setAddMode('api-key')}
              onChooseOAuth={oauthAvailable ? () => setAddMode('oauth') : undefined}
              onChooseClaudeCode={claudeCodeConnectable ? () => setAddMode('claude-code') : undefined}
              onChooseBrowser={provider.oauthId === 'openai-codex' ? () => setAddMode('oauth-browser') : undefined}
              onCancel={() => setAddMode('closed')}
            />
          )}

          {canWrite && addMode === 'claude-code' && claudeCode && (
            <ClaudeCodeAccountSetup status={claudeCode} onDone={closeAdd} onCancel={() => setAddMode('closed')} />
          )}

          {canWrite && addMode === 'api-key' && (
            <AddAccountForm providerId={provider.id} onDone={closeAdd} onCancel={() => setAddMode('closed')} />
          )}

          {canWrite && (addMode === 'oauth' || addMode === 'oauth-browser') && (
            <OAuthFlow
              preferredMethod={addMode === 'oauth-browser' ? 'browser' : 'device_code'}
              providerId={provider.oauthId ?? provider.id}
              providerName={provider.oauthLabel ?? provider.name}
              onDone={closeAdd}
              onCancel={() => setAddMode('closed')}
            />
          )}
        </div>
      )}
    </div>
  )
}

/** Inline chooser shown after clicking "Connect account" on a provider with more than an API key. */
export function AddAccountChooser({
  oauthLabel,
  onChooseApiKey,
  onChooseOAuth,
  onChooseClaudeCode,
  onChooseBrowser,
  onCancel,
}: {
  oauthLabel: string
  onChooseApiKey: () => void
  onChooseOAuth?: () => void
  /** Anthropic, where Claude Code is offered: use the user's own Claude Code. */
  onChooseClaudeCode?: () => void
  onChooseBrowser?: () => void
  onCancel: () => void
}) {
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        {onChooseClaudeCode && (
          <button
            type="button"
            onClick={onChooseClaudeCode}
            className="ficus-button ficus-button-primary rounded-lg px-4 py-2.5 text-sm font-medium"
          >
            Claude Code (your Claude plan)
          </button>
        )}
        {onChooseOAuth && (
          <button
            type="button"
            onClick={onChooseOAuth}
            className="ficus-button ficus-button-primary rounded-lg px-4 py-2.5 text-sm font-medium"
          >
            Login with {oauthLabel}
          </button>
        )}
        <button
          type="button"
          onClick={onChooseApiKey}
          className="ficus-button rounded-lg border border-th-border px-4 py-2.5 text-sm font-medium text-primary hover:bg-surface-hover"
        >
          API key
        </button>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        {onChooseBrowser && (
          <button
            type="button"
            onClick={onChooseBrowser}
            className="ficus-button ficus-button-secondary px-3 py-1.5 text-xs rounded font-medium"
          >
            Browser login (fallback)
          </button>
        )}
        <button
          type="button"
          onClick={onCancel}
          className="ficus-button ficus-button-secondary ml-auto rounded-lg px-4 py-2 text-sm font-medium"
        >
          Cancel
        </button>
      </div>
    </div>
  )
}

/** Label + API key form. Always posts to the primary provider id (never a dedicated OAuth backend id). */
export function AddAccountForm({
  providerId,
  onDone,
  onCancel,
}: {
  providerId: string
  onDone: () => void
  onCancel: () => void
}) {
  const [keyValue, setKeyValue] = useState('')
  const [labelValue, setLabelValue] = useState('')

  const addMutation = useMutation({
    mutationFn: () => addProviderAccount(providerId, keyValue, labelValue || undefined),
    onSuccess: () => {
      setKeyValue('')
      setLabelValue('')
      onDone()
    },
  })

  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="min-w-0 space-y-2 text-sm text-secondary">
          <span className="block">
            Account label <span className="text-muted">(optional)</span>
          </span>
          <input
            value={labelValue}
            onChange={(e) => setLabelValue(e.target.value)}
            placeholder="e.g. Work"
            disabled={addMutation.isPending}
            className="ficus-field w-full rounded-lg px-3 py-2 text-sm"
          />
        </label>
        <label className="min-w-0 space-y-2 text-sm text-secondary">
          <span className="block">API key</span>
          <input
            type="password"
            value={keyValue}
            onChange={(e) => setKeyValue(e.target.value)}
            placeholder="Enter API key"
            disabled={addMutation.isPending}
            className="ficus-field w-full rounded-lg px-3 py-2 text-sm"
          />
        </label>
      </div>
      {addMutation.isError && (
        <p role="alert" className="text-sm text-danger">
          Failed to save
        </p>
      )}
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => addMutation.mutate()}
          disabled={!keyValue || addMutation.isPending}
          className="ficus-button ficus-button-primary rounded-lg px-4 py-2 text-sm font-medium disabled:opacity-50"
        >
          {addMutation.isPending ? 'Saving…' : 'Save'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={addMutation.isPending}
          className="ficus-button ficus-button-secondary disabled:opacity-50 rounded-lg px-4 py-2 text-sm font-medium"
        >
          Cancel
        </button>
      </div>
    </div>
  )
}

export function ProviderAccountsList({
  providerId,
  accounts,
  canWrite,
  oauthLabel,
  claudeCode,
}: {
  providerId: string
  accounts: ProviderAccountEntry[]
  canWrite: boolean
  /** Display name used for the OAuth flow when re-authenticating an existing oauth account row. */
  oauthLabel?: string
  /** Claude Code status, so a Claude Code account row can say when `claude` is signed out. */
  claudeCode?: ClaudeCodeStatus
}) {
  const queryClient = useQueryClient()
  const [editingAccountId, setEditingAccountId] = useState<string | null>(null)
  const [editLabelValue, setEditLabelValue] = useState('')
  const [reloginAccountId, setReloginAccountId] = useState<string | null>(null)
  const invalidate = () => invalidateProviderRoutingQueries(queryClient)

  const updateMutation = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: { label?: string; enabled?: boolean } }) =>
      updateProviderAccount(providerId, id, patch),
    onSuccess: () => {
      setEditingAccountId(null)
      setEditLabelValue('')
      invalidate()
    },
  })
  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteProviderAccount(providerId, id),
    onSuccess: invalidate,
  })
  const reorderMutation = useMutation({
    mutationFn: (order: string[]) => reorderProviderAccounts(providerId, order),
    onSuccess: invalidate,
  })
  // Cooldowns are an estimate; when the provider's window resets early the
  // operator can clear the record instead of waiting it out.
  const resetHealthMutation = useMutation({
    mutationFn: (id: string) => resetProviderHealth(providerId, id),
    onSuccess: invalidate,
  })

  const moveAccount = (index: number, direction: -1 | 1) => {
    const target = index + direction
    if (target < 0 || target >= accounts.length) return
    const order = accounts.map((account) => account.id)
    ;[order[index], order[target]] = [order[target], order[index]]
    reorderMutation.mutate(order)
  }

  return (
    <div className="space-y-2">
      {accounts.length > 1 && (
        <p className="text-xs text-muted">Used in order of preference; unavailable accounts fail over to the next.</p>
      )}
      <div className="divide-y divide-panel-border">
        {accounts.map((account, index) => (
          <div key={account.id}>
            <div className="flex items-start justify-between gap-3 py-4 text-xs text-muted">
              {canWrite && accounts.length > 1 && (
                <span className="flex flex-col leading-none shrink-0">
                  <button
                    onClick={() => moveAccount(index, -1)}
                    disabled={index === 0 || reorderMutation.isPending}
                    aria-label="Move up"
                    className="ficus-button leading-none hover:text-primary disabled:opacity-30 disabled:cursor-not-allowed"
                  >
                    ▲
                  </button>
                  <button
                    onClick={() => moveAccount(index, 1)}
                    disabled={index === accounts.length - 1 || reorderMutation.isPending}
                    aria-label="Move down"
                    className="ficus-button leading-none hover:text-primary disabled:opacity-30 disabled:cursor-not-allowed"
                  >
                    ▼
                  </button>
                </span>
              )}
              <div className="min-w-0 flex-1 space-y-1">
                {editingAccountId === account.id ? (
                  <input
                    value={editLabelValue}
                    onChange={(e) => setEditLabelValue(e.target.value)}
                    aria-label="Account label"
                    className="ficus-field w-full rounded-lg px-3 py-2 text-sm"
                    autoFocus
                  />
                ) : (
                  <span className="block break-words text-sm font-medium text-primary">
                    {account.label || account.id}
                  </span>
                )}
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-muted">
                    {account.kind === 'claude-code'
                      ? 'Claude Code on this computer'
                      : account.type === 'oauth'
                        ? (oauthLabel ?? 'OAuth')
                        : 'API key'}
                  </span>
                  <span
                    className={clsx(
                      'text-xs',
                      !account.enabled
                        ? 'text-muted'
                        : account.health === 'exhausted' ||
                            (account.kind === 'claude-code' && claudeCode && !claudeCode.loggedIn)
                          ? 'text-status-attention-700 dark:text-status-attention-400'
                          : account.kind === 'openai-compatible' && !account.capabilities
                            ? 'text-muted'
                            : 'text-status-success-700 dark:text-status-success-400'
                    )}
                  >
                    {!account.enabled
                      ? 'Disabled'
                      : account.kind === 'claude-code' && claudeCode && !claudeCode.loggedIn
                        ? claudeCode.installed
                          ? 'Not signed in'
                          : 'Not installed'
                        : account.health === 'exhausted'
                          ? 'Exhausted'
                          : account.kind === 'openai-compatible' && !account.capabilities
                            ? 'Unverified'
                            : 'Available'}
                  </span>
                  {account.enabled &&
                    account.health === 'exhausted' &&
                    healthDetail(account.healthReason, account.retryAt) && (
                      <span className="text-xs text-muted">{healthDetail(account.healthReason, account.retryAt)}</span>
                    )}
                  {account.enabled && account.health === 'exhausted' && account.kind === 'claude-code' && (
                    <span className="text-xs text-muted">
                      {account.healthReason === 'invalid-credential'
                        ? 'Claude Code is too old: run `claude update`, then Reset.'
                        : account.healthReason === 'expired-oauth'
                          ? 'Claude Code sign-in failed: run `claude auth login`, then Reset.'
                          : null}
                    </span>
                  )}
                  {account.capabilities && (
                    <span
                      className={clsx(
                        'px-1.5 py-0.5 rounded',
                        account.capabilities.tools ? 'text-status-success-700' : 'text-status-danger-700'
                      )}
                    >
                      {account.capabilities.tools ? 'Tools supported' : 'No tool support'}
                      {account.capabilities.contextWindow ? ` · ${account.capabilities.contextWindow} ctx` : ''}
                    </span>
                  )}
                </div>
              </div>
              {canWrite && (
                <fieldset
                  disabled={updateMutation.isPending || deleteMutation.isPending}
                  className="flex flex-wrap items-center gap-x-3 gap-y-2 disabled:opacity-50 [&>button]:whitespace-nowrap"
                >
                  {editingAccountId === account.id ? (
                    <>
                      <button
                        onClick={() => updateMutation.mutate({ id: account.id, patch: { label: editLabelValue } })}
                        className="ficus-button hover:text-primary"
                      >
                        Save label
                      </button>
                      <button
                        onClick={() => {
                          setEditingAccountId(null)
                          setEditLabelValue('')
                        }}
                        className="ficus-button hover:text-primary"
                      >
                        Cancel
                      </button>
                    </>
                  ) : (
                    <>
                      {account.enabled &&
                        account.health === 'exhausted' &&
                        (isCredentialHealthReason(account.healthReason) && account.kind !== 'claude-code' ? (
                          <span className="text-muted">Re-authorize to clear</span>
                        ) : (
                          <button
                            onClick={() => resetHealthMutation.mutate(account.id)}
                            disabled={resetHealthMutation.isPending}
                            aria-label={`Reset health for ${account.label || account.id}`}
                            className="ficus-button hover:text-primary disabled:opacity-50"
                          >
                            Reset
                          </button>
                        ))}
                      <ProviderAccountActions label={account.label || account.id}>
                        <button
                          onClick={() => {
                            setEditingAccountId(account.id)
                            setEditLabelValue(account.label ?? '')
                          }}
                          className="ficus-button hover:text-primary"
                        >
                          Edit label
                        </button>
                        {account.type === 'oauth' && (
                          <button
                            onClick={() => setReloginAccountId(account.id)}
                            className="ficus-button hover:text-primary"
                          >
                            Re-authorize
                          </button>
                        )}
                        <button
                          onClick={() =>
                            updateMutation.mutate({ id: account.id, patch: { enabled: !account.enabled } })
                          }
                          className="ficus-button hover:text-primary"
                        >
                          {account.enabled ? 'Disable' : 'Enable'}
                        </button>
                        <button
                          onClick={() => {
                            if (confirm(`Delete account ${account.label || account.id}?`))
                              deleteMutation.mutate(account.id)
                          }}
                          className="ficus-button text-status-danger-600 dark:text-status-danger-400 hover:text-status-danger-800 dark:hover:text-status-danger-300"
                        >
                          Delete
                        </button>
                      </ProviderAccountActions>
                    </>
                  )}
                </fieldset>
              )}
            </div>
            {reloginAccountId === account.id && (
              <div className="mt-2 pl-3 border-l-2 border-th-border">
                <OAuthFlow
                  providerId={providerId}
                  providerName={oauthLabel ?? providerId}
                  // Re-authorize refreshes THIS account's credential in place,
                  // never adding a duplicate.
                  accountId={account.id}
                  onDone={() => {
                    setReloginAccountId(null)
                    invalidate()
                  }}
                  onCancel={() => setReloginAccountId(null)}
                />
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

function ApiKeyForm({
  providerId,
  onDone,
  onCancel,
}: {
  providerId: string
  onDone: () => void
  onCancel: () => void
}) {
  const [value, setValue] = useState('')

  const mutation = useMutation({
    mutationFn: (key: string) => setProviderApiKey(providerId, key),
    onSuccess: onDone,
  })

  return (
    <div className="mt-3 flex items-center gap-2">
      <input
        type="password"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && value) mutation.mutate(value)
          if (e.key === 'Escape') onCancel()
        }}
        placeholder="Enter API key..."
        className="ficus-field flex-1 text-sm bg-surface-secondary border border-th-border rounded px-2 py-1.5 text-primary placeholder:text-placeholder  focus:ring-1 focus:ring-accent"
        autoFocus
      />
      <button
        onClick={() => mutation.mutate(value)}
        disabled={!value || mutation.isPending}
        className="ficus-button ficus-button-primary text-xs bg-accent text-on-accent px-3 py-1.5 rounded font-medium hover:bg-accent-hover disabled:opacity-50"
      >
        {mutation.isPending ? 'Saving...' : 'Save'}
      </button>
      <button
        onClick={onCancel}
        className="ficus-button ficus-button-secondary px-3 py-1.5 text-xs rounded font-medium"
      >
        Cancel
      </button>
      {mutation.isError && (
        <span className="text-xs text-status-danger-600 dark:text-status-danger-400">Failed to save</span>
      )}
    </div>
  )
}

function OAuthFlow({
  providerId,
  providerName,
  accountId,
  preferredMethod = 'device_code',
  onDone,
  onCancel,
}: {
  providerId: string
  providerName: string
  /**
   * When set, the flow REAUTHORIZES this exact existing account (its credential
   * is refreshed in place). When omitted, the flow ADDS a new account.
   */
  accountId?: string
  preferredMethod?: 'device_code' | 'browser'
  onDone: () => void
  onCancel: () => void
}) {
  const queryClient = useQueryClient()
  const [code, setCode] = useState('')
  const [localError, setLocalError] = useState<string | null>(null)
  const [hasStarted, setHasStarted] = useState(false)
  const openedAuthUrlRef = useRef<string | null>(null)
  const selectedMethodRef = useRef(false)
  const retiringRef = useRef(false)

  const statusQuery = useQuery({ ...queries.providerAuth.oauthStatus(providerId), enabled: hasStarted })

  const startMutation = useMutation({
    mutationFn: () => startOAuthFlow(providerId, accountId),
    onSuccess: (data) => {
      if (retiringRef.current) return
      queryClient.setQueryData(queryKeys.providerAuth.oauthStatus(providerId), data)
      if (data.need.kind === 'code') {
        window.open(data.need.authUrl, '_blank')
        openedAuthUrlRef.current = data.need.authUrl
      }
      setHasStarted(true)
    },
    onError: (err: Error) => setLocalError(err.message),
  })

  const selectMutation = useMutation({
    mutationFn: (optionId: string | null) => selectOAuthOption(providerId, optionId),
    onSuccess: (_data, optionId) => {
      if (retiringRef.current) return
      if (optionId === null) onCancel()
      else statusQuery.refetch()
    },
    onError: (err: Error) => setLocalError(err.message),
  })

  const selectMethod = selectMutation.mutate

  const completeMutation = useMutation({
    mutationFn: (authCode: string) => completeOAuthFlow(providerId, authCode),
    onSuccess: () => {
      if (!retiringRef.current) onDone()
    },
    onError: (err: Error) => setLocalError(err.message),
  })

  useEffect(() => {
    startMutation.mutate()
    // Start once for this mounted flow.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!hasStarted || retiringRef.current) return
    const need = statusQuery.data?.need
    if (need?.kind === 'done') onDone()
    if (need?.kind === 'code' && openedAuthUrlRef.current !== need.authUrl) {
      window.open(need.authUrl, '_blank')
      openedAuthUrlRef.current = need.authUrl
    }
  }, [hasStarted, onDone, statusQuery.data?.need])

  const handleSubmitCode = () => {
    const authCode = extractOAuthCode(code)
    if (authCode) completeMutation.mutate(authCode)
  }

  const need = hasStarted ? (statusQuery.data?.need ?? startMutation.data?.need) : undefined
  const autoSelect =
    providerId === 'openai-codex' &&
    need?.kind === 'select' &&
    need.options.some((option) => option.id === preferredMethod)
  useEffect(() => {
    if (autoSelect && !retiringRef.current && !selectedMethodRef.current) {
      selectedMethodRef.current = true
      selectMethod(preferredMethod)
    }
  }, [autoSelect, preferredMethod, selectMethod])
  const retireMutation = useMutation({
    mutationFn: async (retry: boolean) => {
      retiringRef.current = true
      await cancelOAuthFlow(providerId)
      await queryClient.cancelQueries({ queryKey: queryKeys.providerAuth.oauthStatus(providerId) })
      return retry
    },
    onSuccess: (retry) => {
      setHasStarted(false)
      queryClient.removeQueries({ queryKey: queryKeys.providerAuth.oauthStatus(providerId) })
      if (!retry) {
        onCancel()
        return
      }
      retiringRef.current = false
      setLocalError(null)
      setCode('')
      selectedMethodRef.current = false
      openedAuthUrlRef.current = null
      startMutation.reset()
      startMutation.mutate()
    },
    onError: (err: Error) => {
      retiringRef.current = false
      setLocalError(err.message)
    },
  })
  const handleCancel = () => retireMutation.mutate(false)
  const error = localError ?? (need?.kind === 'error' ? need.message : null)
  const loadingDevice =
    providerId === 'openai-codex' &&
    preferredMethod === 'device_code' &&
    !error &&
    (!need || need.kind === 'starting' || autoSelect)

  return (
    <fieldset disabled={retireMutation.isPending} className="mt-3 min-w-0 space-y-3 disabled:opacity-50">
      {(startMutation.isPending || !need || need.kind === 'starting') && !error && !loadingDevice && (
        <p className="text-sm text-muted">Starting {providerName} login...</p>
      )}

      {autoSelect && !error && !loadingDevice && (
        <p className="text-sm text-muted">Starting {preferredMethod === 'browser' ? 'browser' : 'device'} login…</p>
      )}
      {need?.kind === 'select' && !autoSelect && (
        <SelectStep
          need={need}
          isPending={selectMutation.isPending}
          onSelect={(optionId) => selectMutation.mutate(optionId)}
          onCancel={handleCancel}
        />
      )}

      {need?.kind === 'code' && (
        <CodeStep
          need={need}
          code={code}
          onCodeChange={setCode}
          onSubmit={handleSubmitCode}
          onCancel={handleCancel}
          isSubmitting={completeMutation.isPending}
        />
      )}

      {(loadingDevice || need?.kind === 'device_code') && (
        <DeviceCodeStep need={need?.kind === 'device_code' ? need : undefined} onCancel={handleCancel} />
      )}

      {completeMutation.isPending && <p className="text-sm text-muted">Completing authentication...</p>}

      {error && <ErrorStep message={error} onRetry={() => retireMutation.mutate(true)} onCancel={handleCancel} />}
    </fieldset>
  )
}

export function SelectStep({
  need,
  isPending,
  onSelect,
  onCancel,
}: {
  need: Extract<OAuthNeed, { kind: 'select' }>
  isPending: boolean
  onSelect: (optionId: string) => void
  onCancel: () => void
}) {
  // OpenAI Codex's login flow is the only "select" prompt in use today, and
  // it offers exactly these two methods (ids fixed by the vendored OAuth
  // library — see @earendil-works/pi-ai's auth/oauth/openai-codex.js, where
  // "browser" is hardcoded first/"(default)"). Device code works headlessly
  // and Ficus detects completion automatically, while browser login redirects
  // to a localhost URL that fails to load outside a local CLI — worse for a
  // hosted instance. We can't relabel/reorder the vendored options, so
  // present device code as the primary action here and demote browser login
  // to an explicit fallback. Any other select prompt (none today) still
  // renders its options in the given order, unchanged.
  const deviceOption = need.options.find((o) => o.id === 'device_code')
  const browserOption = need.options.find((o) => o.id === 'browser')

  if (deviceOption && browserOption && need.options.length === 2) {
    return (
      <div className="space-y-2">
        <p className="text-sm text-primary font-medium">{need.message}</p>
        <button
          onClick={() => onSelect(deviceOption.id)}
          disabled={isPending}
          className="ficus-button ficus-button-primary text-xs bg-accent text-on-accent px-3 py-1.5 rounded font-medium hover:bg-accent-hover disabled:opacity-50"
        >
          Device code login (recommended)
        </button>
        <p className="text-xs text-muted">
          Enter a short code on OpenAI&apos;s site — Ficus detects completion automatically, no local redirect needed.
        </p>
        <div className="flex flex-wrap items-center gap-3 pt-1">
          <button
            onClick={() => onSelect(browserOption.id)}
            disabled={isPending}
            className="ficus-button text-xs text-accent-light hover:text-link-hover font-medium"
          >
            Use browser login instead
          </button>
          <button
            onClick={onCancel}
            className="ficus-button ficus-button-secondary px-3 py-1.5 text-xs rounded font-medium"
          >
            Cancel
          </button>
        </div>
        <p className="text-xs text-muted">
          Browser login redirects to a localhost address that will fail to load in your browser — that&apos;s expected.
          You&apos;ll paste that URL on the next screen to finish.
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-2">
      <p className="text-sm text-primary font-medium">{need.message}</p>
      <div className="flex flex-wrap gap-2">
        {need.options.map((option) => (
          <button
            key={option.id}
            onClick={() => onSelect(option.id)}
            disabled={isPending}
            className="ficus-button ficus-button-primary text-xs bg-accent text-on-accent px-3 py-1.5 rounded font-medium hover:bg-accent-hover disabled:opacity-50"
          >
            {option.label}
          </button>
        ))}
        <button
          onClick={onCancel}
          className="ficus-button ficus-button-secondary px-3 py-1.5 text-xs rounded font-medium"
        >
          Cancel
        </button>
      </div>
    </div>
  )
}

export function CodeStep({
  need,
  code,
  onCodeChange,
  onSubmit,
  onCancel,
  isSubmitting = false,
}: {
  need: Extract<OAuthNeed, { kind: 'code' }>
  code: string
  onCodeChange: (code: string) => void
  onSubmit: () => void
  onCancel: () => void
  isSubmitting?: boolean
}) {
  return (
    <>
      <div className="bg-surface-secondary rounded-md p-3 space-y-2">
        <p className="text-sm text-primary font-medium">Complete login in the browser window that just opened.</p>
        {need.instructions && <p className="text-xs text-muted">{need.instructions}</p>}
        <p className="text-xs text-muted">
          The final step redirects to a localhost address that will fail to load in your browser — that&apos;s expected.
          Copy that URL from the address bar (or just the authorization code) and paste it below.
        </p>
        <a
          href={need.authUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-accent-light hover:text-link-hover underline"
        >
          Open login page manually →
        </a>
      </div>
      <div className="flex items-center gap-2">
        <input
          type="text"
          value={code}
          onChange={(e) => onCodeChange(extractOAuthCode(e.target.value))}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onSubmit()
            if (e.key === 'Escape') onCancel()
          }}
          placeholder="Paste authorization code or redirect URL here..."
          className="ficus-field flex-1 text-sm bg-surface-secondary border border-th-border rounded px-2 py-1.5 text-primary placeholder:text-placeholder  focus:ring-1 focus:ring-accent font-mono"
          autoFocus
        />
        <button
          onClick={onSubmit}
          disabled={!code.trim() || isSubmitting}
          className="ficus-button ficus-button-primary text-xs bg-accent text-on-accent px-3 py-1.5 rounded font-medium hover:bg-accent-hover disabled:opacity-50"
        >
          {isSubmitting ? 'Submitting...' : 'Submit'}
        </button>
        <button
          onClick={onCancel}
          className="ficus-button ficus-button-secondary px-3 py-1.5 text-xs rounded font-medium"
        >
          Cancel
        </button>
      </div>
    </>
  )
}

export function DeviceCodeStep({
  need,
  onCancel,
}: {
  need?: Extract<OAuthNeed, { kind: 'device_code' }>
  onCancel: () => void
}) {
  // Same copy-to-clipboard pattern as PublicKeyBlock: local state + a 2s
  // "Copied" text swap, rather than a new shared abstraction — no generic
  // clipboard hook/component exists in this codebase yet to reuse. Unlike
  // PublicKeyBlock, this only flips to "Copied" once the write actually
  // resolves — an insecure context (no navigator.clipboard) or a
  // permission-denied rejection must not tell the user their code was
  // copied when it wasn't.
  const [copied, setCopied] = useState(false)
  const [copyFailed, setCopyFailed] = useState(false)
  const copiedTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (copiedTimeoutRef.current) clearTimeout(copiedTimeoutRef.current)
    }
  }, [])

  const copyCode = () => {
    if (!need) return
    if (copiedTimeoutRef.current) clearTimeout(copiedTimeoutRef.current)
    if (!navigator.clipboard) {
      setCopied(false)
      setCopyFailed(true)
      return
    }
    navigator.clipboard.writeText(need.userCode).then(
      () => {
        setCopyFailed(false)
        setCopied(true)
        copiedTimeoutRef.current = setTimeout(() => setCopied(false), 2000)
      },
      () => {
        setCopied(false)
        setCopyFailed(true)
      }
    )
  }

  return (
    <div
      role="group"
      aria-label="Device login"
      aria-busy={!need}
      className="bg-surface-secondary rounded-md p-3 space-y-2"
    >
      <p className="text-sm text-primary font-medium">Complete device login.</p>
      <p className="text-xs text-muted">Open the verification page and enter this code:</p>
      <div className="flex items-center gap-2">
        <div className="flex min-h-7 items-center font-mono text-lg text-primary tracking-widest">
          {need ? need.userCode : <SkeletonLine className="h-6 w-40 !bg-th-border" />}
        </div>
        <button
          onClick={copyCode}
          disabled={!need}
          className="ficus-button text-xs text-accent-light hover:text-link-hover font-medium shrink-0 disabled:opacity-50"
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      {copyFailed && (
        <p className="text-xs text-status-danger-600 dark:text-status-danger-400">
          Couldn&apos;t copy — select the code manually.
        </p>
      )}
      <div className="min-h-4 text-xs">
        {need ? (
          <a
            href={need.verificationUri}
            target="_blank"
            rel="noopener noreferrer"
            className="break-all text-accent-light hover:text-link-hover underline"
          >
            {need.verificationUri}
          </a>
        ) : (
          <SkeletonLine className="h-4 w-64 max-w-full !bg-th-border" />
        )}
      </div>
      {!need ? (
        <SkeletonLine className="h-4 w-28 !bg-th-border" />
      ) : need.expiresInSeconds ? (
        <p className="text-xs text-muted">
          Expires in{' '}
          {need.expiresInSeconds >= 60
            ? `${Math.ceil(need.expiresInSeconds / 60)} ${need.expiresInSeconds <= 60 ? 'minute' : 'minutes'}`
            : `${need.expiresInSeconds} seconds`}
          .
        </p>
      ) : null}
      <p role="status" className="text-xs text-muted">
        {need ? 'Waiting for authorization...' : 'Preparing code and sign-in link…'}
      </p>
      <div>
        <button
          onClick={onCancel}
          disabled={!need}
          className="ficus-button ficus-button-secondary disabled:opacity-50 px-3 py-1.5 text-xs rounded font-medium"
        >
          Cancel
        </button>
      </div>
    </div>
  )
}

export function ErrorStep({
  message,
  onRetry,
  onCancel,
}: {
  message: string
  onRetry: () => void
  onCancel: () => void
}) {
  return (
    <div className="space-y-2">
      <p className="text-sm text-status-danger-600 dark:text-status-danger-400">Login failed: {message}</p>
      <div className="flex gap-2">
        <button onClick={onRetry} className="ficus-button text-xs text-accent-light hover:text-link-hover font-medium">
          Try Again
        </button>
        <button
          onClick={onCancel}
          className="ficus-button ficus-button-secondary px-3 py-1.5 text-xs rounded font-medium"
        >
          Cancel
        </button>
      </div>
    </div>
  )
}

const CONTEXT_WINDOW_FLOOR = 16_384
export function CompatibleCapabilityWarnings({
  tools,
  contextWindow,
  contextFloor,
}: {
  tools: boolean
  contextWindow?: number
  contextFloor: number
}) {
  return (
    <>
      {!tools && (
        <p role="alert" className="text-danger">
          This tool-less model cannot be Primary; Ficus agents require tools.
        </p>
      )}
      {contextWindow != null && contextWindow < contextFloor && (
        <p role="alert" className="text-warning">
          Context window is below {contextFloor}; Fallback is recommended.
        </p>
      )}
    </>
  )
}

export function CompatibleProviderSetup({ canWrite }: { canWrite: boolean }) {
  const queryClient = useQueryClient()
  const { data: tiers = [] } = useQuery({ queryKey: ['model-tiers'], queryFn: getModelTiers })
  const [baseUrl, setBaseUrl] = useState('')
  const [providerId, setProviderId] = useState('local')
  const [apiKey, setApiKey] = useState('')
  const [models, setModels] = useState<string[]>([])
  const [model, setModel] = useState('')
  const [probe, setProbe] = useState<CompatibleProbeResult | null>(null)
  const [contextFloor, setContextFloor] = useState(CONTEXT_WINDOW_FLOOR)
  const [position, setPosition] = useState<'primary' | 'fallback'>('primary')
  const [selectedTiers, setSelectedTiers] = useState<string[]>([])
  const [error, setError] = useState('')
  const primaryRefused = probe != null && !probe.capabilities.tools
  const spec = model ? `${providerId}:${model}` : ''

  async function detect() {
    setError('')
    try {
      const found = await detectCompatibleServers()
      if (found[0]) {
        setBaseUrl(found[0].baseUrl)
        setModels(found[0].models)
        setModel(found[0].models[0] ?? '')
      } else setError('No local servers answered.')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }
  async function verify() {
    setError('')
    try {
      const result = await probeCompatibleProvider({ baseUrl, model, apiKey: apiKey || undefined })
      setProbe(result)
      setContextFloor(result.contextWindowFloor)
      const small =
        result.capabilities.contextWindow != null && result.capabilities.contextWindow < result.contextWindowFloor
      setPosition(!result.capabilities.tools || small ? 'fallback' : 'primary')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }
  async function save() {
    if (!probe) return
    if (position === 'primary' && primaryRefused) {
      setError('Primary is refused: this model did not call tools.')
      return
    }
    const originals = selectedTiers.map((slug) => tiers.find((item) => item.slug === slug)!)
    try {
      await assignCompatibleProvider({
        tiers: originals,
        spec,
        position,
        add: () => addCompatibleProvider({ baseUrl, model, providerId, apiKey: apiKey || undefined, label: model }),
        update: updateModelTier,
        rollbackProvider: () => deleteProviderAuth(providerId),
      })
      queryClient.invalidateQueries({ queryKey: ['model-tiers'] })
      queryClient.invalidateQueries({ queryKey: queryKeys.providerAuth.all })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }
  return (
    <section className="ficus-section min-w-0 space-y-4 overflow-hidden p-4">
      <div>
        <h4 data-setting-target="local-openai-compatible" className="font-medium text-primary">
          Local / OpenAI-compatible
        </h4>
        <p className="mt-0.5 text-sm text-muted">
          Connect Ollama, LM Studio, vLLM, or another server that exposes an OpenAI-compatible API.
        </p>
      </div>
      <div className="grid min-w-0 gap-3 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
        <label className="min-w-0 space-y-1">
          <span data-setting-target="server-url" className="block text-xs font-medium text-secondary">
            Server URL
          </span>
          <input
            aria-label="Custom server URL"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="http://localhost:8080/v1"
            className="ficus-field w-full min-w-0 rounded border border-th-border bg-surface px-3 py-2 text-primary"
          />
          <span className="block text-xs text-muted">The base URL of the server&apos;s OpenAI-compatible API.</span>
        </label>
        <button
          disabled={!canWrite}
          onClick={detect}
          className="ficus-button w-fit whitespace-nowrap rounded bg-surface-secondary px-3 py-2 text-sm text-primary disabled:opacity-50"
        >
          Detect local servers
        </button>
      </div>
      <div className="grid min-w-0 gap-3 md:grid-cols-2 xl:grid-cols-3">
        <label className="min-w-0 space-y-1">
          <span data-setting-target="provider-id" className="block text-xs font-medium text-secondary">
            Provider ID
          </span>
          <input
            aria-label="Provider ID"
            value={providerId}
            onChange={(e) => setProviderId(e.target.value)}
            placeholder="local"
            className="ficus-field w-full min-w-0 rounded border border-th-border bg-surface px-3 py-2 text-primary"
          />
          <span className="block text-xs text-muted">Short prefix used in model specs, such as local:qwen.</span>
        </label>
        <label className="min-w-0 space-y-1">
          <span data-setting-target="model-id" className="block text-xs font-medium text-secondary">
            Model ID
          </span>
          <input
            aria-label="Model ID"
            list="compatible-models"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder="qwen2.5-coder:latest"
            className="ficus-field w-full min-w-0 rounded border border-th-border bg-surface px-3 py-2 text-primary"
          />
          <span className="block text-xs text-muted">The exact model name exposed by the server.</span>
          <datalist id="compatible-models">
            {models.map((id) => (
              <option key={id}>{id}</option>
            ))}
          </datalist>
        </label>
        <label className="min-w-0 space-y-1">
          <span data-setting-target="api-key-optional" className="block text-xs font-medium text-secondary">
            API key (optional)
          </span>
          <input
            aria-label="Optional API key"
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="Not required for most local servers"
            className="ficus-field w-full min-w-0 rounded border border-th-border bg-surface px-3 py-2 text-primary"
          />
          <span className="block text-xs text-muted">Only needed when the server requires authentication.</span>
        </label>
      </div>
      <div>
        <button
          disabled={!baseUrl || !providerId || !model || !canWrite}
          onClick={verify}
          className="ficus-button ficus-button-primary rounded bg-accent px-3 py-2 text-sm text-on-accent disabled:opacity-50"
        >
          Verify capabilities
        </button>
      </div>
      {probe && (
        <div className="space-y-2 text-sm">
          <p>
            Tools: <strong>{probe.capabilities.tools ? 'Supported' : 'Not supported'}</strong>
            {probe.capabilities.contextWindow ? ` · Context: ${probe.capabilities.contextWindow}` : ''}
          </p>
          <CompatibleCapabilityWarnings
            tools={probe.capabilities.tools}
            contextWindow={probe.capabilities.contextWindow}
            contextFloor={contextFloor}
          />
          <div className="flex gap-4">
            <label>
              <input
                type="radio"
                checked={position === 'primary'}
                disabled={primaryRefused}
                onChange={() => setPosition('primary')}
              />{' '}
              Primary
            </label>
            <label>
              <input type="radio" checked={position === 'fallback'} onChange={() => setPosition('fallback')} /> Fallback
            </label>
          </div>
          <div>
            {tiers.map((tier: ModelTierConfig) => (
              <label key={tier.slug} className="block">
                <input
                  type="checkbox"
                  checked={selectedTiers.includes(tier.slug)}
                  onChange={(e) =>
                    setSelectedTiers(
                      e.target.checked
                        ? [...selectedTiers, tier.slug]
                        : selectedTiers.filter((slug) => slug !== tier.slug)
                    )
                  }
                />{' '}
                {tier.label}
                <div className="ml-5 break-all font-mono text-xs">
                  {withTierPosition(tier.chain, spec, position)
                    .split(',')
                    .map((entry, index) => (
                      <div key={`${entry}-${index}`}>
                        {index + 1}. {entry}
                        {entry === spec && (
                          <strong className="ml-2 text-accent-light">
                            ← new ({position === 'primary' ? 'Primary' : 'Fallback'})
                          </strong>
                        )}
                      </div>
                    ))}
                </div>
              </label>
            ))}
          </div>
          <button
            onClick={save}
            disabled={!selectedTiers.length || !canWrite}
            className="ficus-button ficus-button-primary rounded bg-accent px-3 py-2 text-on-accent disabled:opacity-50"
          >
            Add provider and assign tiers
          </button>
        </div>
      )}
      {error && (
        <p role="alert" className="text-danger">
          {error}
        </p>
      )}
    </section>
  )
}
