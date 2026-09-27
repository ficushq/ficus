import { squadSlugMap, type Squad } from '@ficus/shared'
import { queries } from '../../queryOptions'
import { useState, type ComponentType } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import clsx from 'clsx'
import { useOnboarding } from '../../hooks/useOnboarding'
import { onboardingQueryKeys } from '../../queryKeys'
import {
  skipOnboardingItem,
  unskipOnboardingItem,
  type OnboardingItem,
  type OnboardingItemId,
} from '../../api/onboarding'
import { AssistantMemorySection } from '../settings/AssistantMemorySection'
import { ProviderAuthSection } from '../settings/ProviderAuthSection'
import { GitHubIntegrationSettings } from '../integrations/GitHubIntegrationSettings'
import { usePermissions } from '../../hooks/usePermissions'
import { InviteTeamStep } from './InviteTeamStep'
import { ChatChannelSetup } from './ChatChannelSetup'
import { FirstSquadStep, pickMostRecentlyCreated } from './FirstSquadStep'
import { STATE_BADGE_CLASS, STATE_LABEL } from './onboardingItemPresentation'
import { ChevronDownIcon, CheckIcon } from '../icons'
import { LoadingSurface, SkeletonBlock, SkeletonCard, SkeletonLine, SkeletonRows } from '../loading/Skeleton'
import { ThemePreferenceControl } from '../ThemePreferenceControl'

export interface OnboardingItemMeta {
  id: OnboardingItemId
  title: string
  why: string
  linkTo: string
  linkLabel: string
}

// DISPLAY order, owned here — it no longer mirrors ONBOARDING_ITEM_ORDER in
// apps/core/src/services/onboarding/status.ts, which stays the server's own
// ordering. The page groups these into a focused core pass and optional
// follow-ups (see CORE_ITEM_IDS), so presentation order is a UI decision.
// Deep links copy the exact tab-link form SettingsPage.tsx's own surfaces use
// (`<Link to="/settings?section=...">`, see components/squads/IntegrationSettings.tsx).
const ONBOARDING_ITEM_META: readonly OnboardingItemMeta[] = [
  // CORE GROUP — the path to a working instance, in the order you'd do it:
  // a provider so agents can think, GitHub so they can reach your code, then a
  // squad for them to work in. GitHub is optional but lives here because a
  // squad with no repo access is the common disappointing first run.
  {
    id: 'ai_provider',
    title: 'Connect an AI provider',
    why: 'Choose the AI your agents will use. You can always connect more later.',
    linkTo: '/settings?section=providers',
    linkLabel: 'AI Providers',
  },
  {
    id: 'github',
    title: 'Connect GitHub',
    why: 'Connect your repositories, issues, and pull requests. Optional.',
    linkTo: '/settings?section=integrations',
    linkLabel: 'Set up GitHub',
  },
  {
    id: 'first_squad',
    title: 'Create your first squad',
    why: 'Give your agents a shared purpose and a place to work.',
    // FirstSquadStep (registered in ITEM_ROW_COMPONENTS below) replaces the
    // deep link with a guided create-squad + kickoff form; linkTo/linkLabel
    // are unused by that row but kept for the OnboardingItemMeta shape.
    linkTo: '/squads',
    linkLabel: 'Squads',
  },
]

// Keep the essentials first, with optional extras grouped below.
const CORE_ITEM_IDS: readonly OnboardingItemId[] = ['ai_provider', 'github', 'first_squad']

/** Guided initial setup using the same connection forms as Settings. */
export function OnboardingPage() {
  const { status, isAdmin, isPermissionsLoading } = useOnboarding()
  const queryClient = useQueryClient()
  const [createdSquad, setCreatedSquad] = useState<Squad | null>(null)

  const skipMutation = useMutation({
    mutationFn: (id: OnboardingItemId) => skipOnboardingItem(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: onboardingQueryKeys.all }),
  })
  const unskipMutation = useMutation({
    mutationFn: (id: OnboardingItemId) => unskipOnboardingItem(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: onboardingQueryKeys.all }),
  })

  // Loading is checked BEFORE the admin gate (SettingsPage's isSectionAllowed
  // precedent: `if (isLoading) return false` guards the permission check the
  // same way). Collapsing "unresolved" into "not admin" here would flash the
  // restricted-access message for a brand-new admin landing on /onboarding
  // right after first registration, before their settings:read permission
  // has loaded — exactly the first-run moment this page exists for.
  if (isPermissionsLoading) {
    return <OnboardingSkeleton />
  }

  if (!isAdmin) {
    return <div className="py-12 text-center text-sm text-muted">Onboarding is only visible to admins.</div>
  }

  if (!status) {
    return <OnboardingSkeleton />
  }

  const itemsById = new Map(status.items.map((item) => [item.id, item]))

  return (
    <div className="mx-auto w-full min-w-0 max-w-2xl space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
        <div className="min-w-0">
          <h1 className="text-lg font-semibold text-primary">Set up Tau</h1>
          <p className="text-sm text-muted mt-1">
            {status.ready
              ? 'Your workspace is ready. You can revisit any step below.'
              : 'Connect your AI, choose your tools, and create a squad.'}
          </p>
        </div>
        <ThemePreferenceControl />
      </div>

      {(() => {
        const settled = (id: OnboardingItemId) => {
          const state = itemsById.get(id)?.state
          return state === 'done' || state === 'skipped'
        }
        const coreDone = CORE_ITEM_IDS.every(settled)

        return (
          <div className="space-y-6">
            <SetupSteps
              core={ONBOARDING_ITEM_META}
              onSquadCreated={setCreatedSquad}
              itemsById={itemsById}
              onSkip={(id, onSkipped) => skipMutation.mutate(id, { onSuccess: onSkipped })}
              onUnskip={(id) => unskipMutation.mutate(id)}
              pending={skipMutation.isPending || unskipMutation.isPending}
            />

            {coreDone && (
              <div className="flex items-center justify-between gap-4">
                <p className="text-sm text-muted">You’re ready to get started.</p>
                <OpenTauLink createdSquad={createdSquad} />
              </div>
            )}
            <section className="border-t border-th-border pt-5">
              <h2 className="text-sm font-medium text-secondary">Optional setup</h2>
              <p className="mt-1 text-xs text-muted">Make Tau your own. You can also set these up later in Settings.</p>
              <OptionalSetup />
            </section>
          </div>
        )
      })()}

      {(skipMutation.isError || unskipMutation.isError) && (
        <p role="alert" className="text-sm text-status-danger-600 dark:text-status-danger-400">
          Failed to update this item. Try again.
        </p>
      )}
    </div>
  )
}

function OpenTauLink({ createdSquad }: { createdSquad: Squad | null }) {
  const { data: squads = [] } = useQuery(queries.squads.list())
  const target = createdSquad ?? pickMostRecentlyCreated(squads)
  const slug = target ? (squadSlugMap(squads).idToSlug[target.id] ?? target.id) : null
  const to = target?.managerAgentId
    ? `/squads/${encodeURIComponent(slug!)}/agents?agent=${encodeURIComponent(target.managerAgentId)}`
    : '/squads'
  return (
    <Link to={to} className="ficus-button ficus-button-primary rounded-lg px-4 py-2 text-sm font-medium">
      Open Tau
    </Link>
  )
}

function SetupSteps({
  core,
  onSquadCreated,
  itemsById,
  onSkip,
  onUnskip,
  pending,
}: {
  onSquadCreated: (squad: Squad) => void
  core: readonly OnboardingItemMeta[]
  itemsById: Map<OnboardingItemId, OnboardingItem>
  onSkip: (id: OnboardingItemId, onSkipped: () => void) => void
  onUnskip: (id: OnboardingItemId) => void
  pending: boolean
}) {
  const first = core.find((meta) => itemsById.get(meta.id)?.state === 'todo')?.id ?? null
  const { search } = useLocation()
  const initial = new URLSearchParams(search).get('setup') === 'github' ? 'github' : first
  const [open, setOpen] = useState<OnboardingItemId | null>(initial)
  const [visited, setVisited] = useState(() => new Set<OnboardingItemId>(initial ? [initial] : []))
  const reveal = (id: OnboardingItemId | null) => {
    setOpen(id)
    if (id) setVisited((current) => new Set([...current, id]))
  }
  return (
    <div className="divide-y divide-th-border">
      {core.map((meta, index) => {
        const item = itemsById.get(meta.id)
        if (!item) return null
        const expanded = open === meta.id
        const settled = item.state === 'done' || item.state === 'skipped'
        const skipAndContinue = () => onSkip(meta.id, () => reveal(core[index + 1]?.id ?? null))
        return (
          <section key={meta.id} className="py-4">
            <SetupStepHeader
              id={meta.id}
              title={meta.title}
              state={item.state}
              number={index + 1}
              expanded={expanded}
              onToggle={() => reveal(expanded ? null : meta.id)}
              onSkip={
                !item.required && item.state !== 'done'
                  ? () => (item.state === 'skipped' ? onUnskip(meta.id) : skipAndContinue())
                  : undefined
              }
              pending={pending}
            />
            <div id={`setup-step-${meta.id}`} hidden={!expanded} className="pt-4 sm:pl-10">
              <p className="mb-4 text-sm text-muted">{meta.why}</p>
              {visited.has(meta.id) && (
                <ItemRow
                  onSquadCreated={onSquadCreated}
                  meta={meta}
                  item={item}
                  onSkip={skipAndContinue}
                  onUnskip={() => onUnskip(meta.id)}
                  pending={pending}
                  embedded
                />
              )}
              {settled && (
                <div className="mt-5 flex justify-end">
                  <button
                    type="button"
                    className="ficus-button text-sm text-accent-light"
                    onClick={() => reveal(core[index + 1]?.id ?? null)}
                  >
                    Continue →
                  </button>
                </div>
              )}
            </div>
          </section>
        )
      })}
    </div>
  )
}

const OPTIONAL_SETUP = [
  { id: 'voice_memory', title: 'Voice & memory', Content: () => <AssistantMemorySection onboarding /> },
  { id: 'invite_users', title: 'Invite your team', Content: InviteTeamStep },
  { id: 'chat_channel', title: 'Connect a chat channel', Content: ChatChannelSetup },
] as const

/** Optional tools have no checklist state and never affect setup completion. */
function OptionalSetup() {
  const [open, setOpen] = useState<string | null>(null)
  const [visited, setVisited] = useState(() => new Set<string>())
  return (
    <div className="divide-y divide-th-border" data-optional-setup>
      {OPTIONAL_SETUP.map(({ id, title, Content }) => (
        <section key={id} className="py-4">
          <SetupStepHeader
            id={id}
            title={title}
            expanded={open === id}
            onToggle={() => {
              setOpen(open === id ? null : id)
              setVisited((current) => new Set([...current, id]))
            }}
          />
          <div id={`setup-step-${id}`} hidden={open !== id} className="pt-4 sm:pl-10">
            {visited.has(id) && <Content />}
          </div>
        </section>
      ))}
    </div>
  )
}

function SetupStepHeader({
  id,
  title,
  state,
  number,
  expanded,
  onToggle,
  onSkip,
  pending,
}: {
  id: string
  title: string
  state?: OnboardingItem['state']
  number?: number
  expanded: boolean
  onToggle: () => void
  onSkip?: () => void
  pending?: boolean
}) {
  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={`setup-step-${id}`}
        data-onboarding-step
        onClick={onToggle}
        className="ficus-button flex min-w-0 flex-1 items-center gap-3 text-left"
      >
        <span
          aria-hidden="true"
          className={clsx(
            'flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs',
            state === 'done' ? 'bg-accent/10 text-accent-light' : 'bg-surface-secondary text-muted'
          )}
        >
          {state === 'done' ? (
            <CheckIcon className="h-4 w-4" />
          ) : (
            (number ?? <span className="h-1.5 w-1.5 rounded-full bg-current" />)
          )}
        </span>
        <span className="flex-1 text-sm font-medium text-primary">{title}</span>
        {(state === 'done' || state === 'skipped') && (
          <span className="text-xs text-muted">
            {id === 'github' && state === 'done' ? 'Account connected' : STATE_LABEL[state]}
          </span>
        )}
      </button>
      {onSkip && (
        <button type="button" disabled={pending} onClick={onSkip} className="ficus-button px-2 py-1 text-xs text-muted">
          {state === 'skipped' ? 'Unskip' : 'Skip'}
        </button>
      )}
      <button
        type="button"
        aria-label={`${title} details`}
        aria-expanded={expanded}
        aria-controls={`setup-step-${id}`}
        onClick={onToggle}
        className="ficus-button p-1 text-muted"
      >
        <ChevronDownIcon className={clsx('h-4 w-4', expanded && 'rotate-180')} />
      </button>
    </div>
  )
}

function OnboardingSkeleton() {
  return (
    <LoadingSurface label="Loading setup checklist" className="mx-auto w-full min-w-0 max-w-2xl space-y-6">
      <div className="space-y-2">
        <SkeletonLine className="h-5 w-28" />
        <SkeletonLine className="w-4/5" />
      </div>
      <div className="space-y-3">
        <SkeletonRows count={3}>
          {(index) => (
            <SkeletonCard key={index} className="flex items-start gap-3">
              <SkeletonBlock className="h-6 w-6 shrink-0 rounded-full" />
              <div className="flex-1 space-y-2">
                <SkeletonLine className={index % 2 ? 'w-2/5' : 'w-3/5'} />
                <SkeletonLine className="w-4/5" />
              </div>
              <SkeletonBlock className="h-8 w-20 shrink-0" />
            </SkeletonCard>
          )}
        </SkeletonRows>
      </div>
    </LoadingSurface>
  )
}

export interface ItemRowProps {
  meta: OnboardingItemMeta
  item: OnboardingItem
  onSkip: () => void
  onUnskip: () => void
  pending: boolean
  embedded?: boolean
  onSquadCreated?: (squad: Squad) => void
}

// Setup and invitations use inline forms; other follow-ups link to Settings.
const ITEM_ROW_COMPONENTS: Partial<Record<OnboardingItemId, ComponentType<ItemRowProps>>> = {
  first_squad: FirstSquadStep,
  ai_provider: ConnectionStep,
  github: ConnectionStep,
}

function ItemRow(props: ItemRowProps) {
  const Component = ITEM_ROW_COMPONENTS[props.meta.id] ?? DeepLinkItemRow
  return <Component {...props} />
}

function DeepLinkItemRow({ meta, item, onSkip, onUnskip, pending, embedded }: ItemRowProps) {
  if (embedded)
    return (
      <Link to={meta.linkTo} className="text-sm text-accent-light hover:underline">
        {meta.linkLabel} →
      </Link>
    )
  return (
    <div className="px-4 py-4 flex items-start justify-between gap-4">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <p className="font-medium text-primary">{meta.title}</p>
          <span className={clsx('text-xs px-1.5 py-0.5 rounded', STATE_BADGE_CLASS[item.state])}>
            {STATE_LABEL[item.state]}
          </span>
        </div>
        <p className="text-sm text-muted mt-0.5">{meta.why}</p>
        <Link to={meta.linkTo} className="text-sm text-accent-light hover:underline mt-1 inline-block">
          {meta.linkLabel} →
        </Link>
      </div>
      {!item.required && item.state !== 'done' && (
        <button
          type="button"
          onClick={item.state === 'skipped' ? onUnskip : onSkip}
          disabled={pending}
          className="ficus-button shrink-0 px-3 py-1.5 text-sm rounded-md border border-th-border text-secondary hover:bg-surface-hover disabled:opacity-50"
        >
          {item.state === 'skipped' ? 'Unskip' : 'Skip'}
        </button>
      )}
    </div>
  )
}

function ConnectionStep({ meta, item, onSkip, onUnskip, pending, embedded }: ItemRowProps) {
  const [editing, setEditing] = useState(false)
  const permissions = usePermissions()
  const showSetup = item.state !== 'skipped' && (meta.id === 'github' || item.state !== 'done' || editing)
  return (
    <div className={clsx('space-y-4', !embedded && 'px-4 py-4')}>
      {!embedded && (
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <p className="font-medium text-primary">{meta.title}</p>
              <span className={clsx('text-xs px-1.5 py-0.5 rounded', STATE_BADGE_CLASS[item.state])}>
                {meta.id === 'github' && item.state === 'done' ? 'Account connected' : STATE_LABEL[item.state]}
              </span>
            </div>
            <p className="mt-1 text-sm text-muted">{meta.why}</p>
          </div>
          {!item.required && item.state !== 'done' && (
            <button
              type="button"
              onClick={item.state === 'skipped' ? onUnskip : onSkip}
              disabled={pending}
              className="ficus-button shrink-0 px-3 py-1.5 text-sm text-secondary disabled:opacity-50"
            >
              {item.state === 'skipped' ? 'Unskip' : 'Skip'}
            </button>
          )}
        </div>
      )}
      {item.state === 'done' && meta.id !== 'github' && (
        <button type="button" className="ficus-button text-sm text-accent-light" onClick={() => setEditing(!editing)}>
          {editing ? 'Close setup' : 'Manage connection'}
        </button>
      )}
      {showSetup &&
        (meta.id === 'ai_provider' ? (
          <ProviderAuthSection onboarding />
        ) : permissions.can('integrations:read:github') ? (
          <GitHubIntegrationSettings
            embedded
            onboarding
            canRead
            canWrite={permissions.can('integrations:write:github')}
          />
        ) : (
          <p className="text-sm text-muted">GitHub setup requires permission to manage integrations.</p>
        ))}
    </div>
  )
}
