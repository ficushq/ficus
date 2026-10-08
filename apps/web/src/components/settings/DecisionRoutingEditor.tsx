import { useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  DECISION_TIMEOUT_MAX_MS,
  type DecisionFeatureSwitch,
  type DecisionProviderView,
  type DecisionPurpose,
  type DecisionRouting,
} from '@ficus/shared'
import {
  setDecisionFeatureSwitch,
  setDecisionRouting,
  type DecisionFeature,
  type DecisionSettings,
  type DecisionSpendDays,
} from '../../api/decisions'
import { queries } from '../../queryOptions'
import { decisionQueryKeys } from '../../queryKeys'
import { Badge, type BadgeColor } from '../Badge'
import { SegmentedControl } from '../SegmentedControl'
import { ChevronDownIcon, CloseIcon, PlusIcon } from '../icons'
import { DECISION_INPUT_CLASS } from './DecisionField'
import { errorText, featureSwitchState, formatSpend, SPEND_ESTIMATE_NOTE } from './decisionUi'
import { DecisionSpendSummary } from './DecisionSpendSummary'

const MIN_TIMEOUT_SECONDS = 0.25
const MAX_TIMEOUT_SECONDS = DECISION_TIMEOUT_MAX_MS / 1000
/** Core's routing schema caps each order at this many providers. */
const MAX_ORDER = 8

/**
 * The features decision models power (with their switches and provider orders), the default
 * order, and how long to wait in all.
 * Edits stay a local draft until saved, so reordering never half-applies.
 */
export function DecisionRoutingEditor({
  providers,
  routing,
  features,
  canWrite,
}: {
  providers: DecisionProviderView[]
  routing: DecisionRouting
  features: DecisionFeature[]
  canWrite: boolean
}) {
  const queryClient = useQueryClient()
  const [spendDays, setSpendDays] = useState<DecisionSpendDays>(30)
  const { data: spend } = useQuery(queries.decisions.spend(spendDays))
  const [draft, setDraft] = useState<DecisionRouting | null>(null)
  const [timeoutText, setTimeoutText] = useState<string | null>(null)
  const current = draft ?? routing
  const known = new Set(providers.map((provider) => provider.id))
  const timeoutSeconds = timeoutText ?? String(current.timeoutMs / 1000)
  const parsedTimeout = Number(timeoutSeconds)
  const timeoutValid =
    timeoutSeconds.trim() !== '' &&
    Number.isFinite(parsedTimeout) &&
    parsedTimeout >= MIN_TIMEOUT_SECONDS &&
    parsedTimeout <= MAX_TIMEOUT_SECONDS
  const dirty = draft !== null || (timeoutText !== null && Number(timeoutText) * 1000 !== routing.timeoutMs)

  const save = useMutation({
    mutationFn: (next: DecisionRouting) => setDecisionRouting(next),
    onSuccess: (saved) => {
      queryClient.setQueryData<DecisionSettings>(decisionQueryKeys.settings(), (old) =>
        old ? { ...old, routing: saved } : old
      )
      setDraft(null)
      setTimeoutText(null)
    },
  })

  const featureSwitch = useMutation({
    mutationFn: ({ id, value }: { id: DecisionPurpose; value: DecisionFeatureSwitch }) =>
      setDecisionFeatureSwitch(id, value),
    onSuccess: (next) =>
      queryClient.setQueryData<DecisionSettings>(decisionQueryKeys.settings(), (old) =>
        old ? { ...old, features: next } : old
      ),
  })

  const edit = (change: (routing: DecisionRouting) => DecisionRouting) => setDraft(change(current))
  const setPurpose = (purpose: DecisionPurpose, ids: string[] | undefined) =>
    edit((routing) => {
      const purposes = { ...routing.purposes }
      if (ids) purposes[purpose] = ids
      else delete purposes[purpose]
      return { ...routing, purposes }
    })

  const submit = () => {
    if (!timeoutValid) return
    // A provider removed since the draft started would fail the whole save.
    const keep = (ids: string[]) => ids.filter((id) => known.has(id))
    save.mutate({
      default: keep(current.default),
      purposes: Object.fromEntries(
        Object.entries(current.purposes).map(([purpose, ids]) => [purpose, keep(ids ?? [])])
      ) as DecisionRouting['purposes'],
      timeoutMs: Math.round(parsedTimeout * 1000),
    })
  }

  const hasProviders = providers.length > 0
  return (
    <div className="space-y-8">
      <section aria-labelledby="decision-features-heading" className="space-y-3">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
          <div className="min-w-0">
            <h4 id="decision-features-heading" className="text-sm font-medium text-secondary">
              Features
            </h4>
            <p className="mt-0.5 text-xs text-muted">
              Everything decision models do in Ficus, and what each costs.
              {hasProviders ? ' Each feature asks the default order unless you give it its own.' : ''}
            </p>
          </div>
          <SegmentedControl
            size="compact"
            ariaLabel="Spend period"
            className="self-start"
            value={String(spendDays) as '1' | '7' | '30'}
            onChange={(next) => setSpendDays(Number(next) as DecisionSpendDays)}
            options={[
              { value: '1', label: '24h' },
              { value: '7', label: '7 days' },
              { value: '30', label: '30 days' },
            ]}
          />
        </div>
        <DecisionSpendSummary spend={spend} />
        <ul className="divide-y divide-th-border border-y border-th-border">
          {features
            .filter((feature) => !feature.parent)
            .map((feature) => {
              const subFeatures = features.filter((sub) => sub.parent === feature.id)
              const parentOn = hasProviders && featureSwitchState(feature).on
              const row = (item: DecisionFeature, parent?: { label: string; on: boolean; ids?: string[] }) => {
                const ids = current.purposes[item.id]
                return (
                  <DecisionFeatureRow
                    key={item.id}
                    feature={item}
                    parent={parent}
                    spend={spend?.byPurpose.find((entry) => entry.purpose === item.id)}
                    approximate={spend?.approximate ?? false}
                    hasProviders={hasProviders}
                    canWrite={canWrite}
                    switching={featureSwitch.isPending}
                    onSwitch={(value) => featureSwitch.mutate({ id: item.id, value })}
                    custom={ids !== undefined}
                    // A sub-feature's own order starts from the one it asks now: its parent's, or the default.
                    onCustomChange={(custom) =>
                      setPurpose(item.id, custom ? [...(parent?.ids ?? current.default)] : undefined)
                    }
                    subFeatures={
                      parent
                        ? undefined
                        : subFeatures.map((sub) =>
                            row(sub, {
                              label: feature.label,
                              on: parentOn,
                              ids: ids?.length ? ids : undefined,
                            })
                          )
                    }
                  >
                    {ids !== undefined && hasProviders && (
                      <ProviderOrder
                        label={`${item.label} order`}
                        ids={ids}
                        providers={providers}
                        disabled={!canWrite}
                        onChange={(next) => setPurpose(item.id, next)}
                        emptyText={
                          parent
                            ? `Empty, so it uses the ${parent.label.toLowerCase()}'s order.`
                            : 'Empty, so it uses the default order.'
                        }
                      />
                    )}
                  </DecisionFeatureRow>
                )
              }
              return row(feature)
            })}
        </ul>
        {featureSwitch.isError && (
          <p role="alert" className="text-sm text-status-danger-600 dark:text-status-danger-400">
            {errorText(featureSwitch.error)}
          </p>
        )}
      </section>

      {hasProviders && (
        <section aria-labelledby="decision-routing-heading" className="space-y-5">
          <div className="space-y-2">
            <div>
              <h4 id="decision-routing-heading" className="text-sm font-medium text-secondary">
                Default order
              </h4>
              <p className="mt-0.5 text-xs text-muted">
                Ficus asks providers from the top; the first to answer in time wins. One that fails is asked last for
                the next 30 seconds.
              </p>
            </div>
            <ProviderOrder
              label="Default order"
              ids={current.default}
              providers={providers}
              disabled={!canWrite}
              onChange={(ids) => edit((routing) => ({ ...routing, default: ids }))}
              emptyText="No order yet: every enabled provider is asked, in the order you added them."
            />
          </div>

          <div className="space-y-1">
            <label htmlFor="decision-timeout" className="block text-sm font-medium text-primary">
              Time limit
            </label>
            <div className="flex items-center gap-2">
              <input
                id="decision-timeout"
                type="number"
                inputMode="decimal"
                min={MIN_TIMEOUT_SECONDS}
                max={MAX_TIMEOUT_SECONDS}
                step={0.25}
                value={timeoutSeconds}
                disabled={!canWrite}
                aria-invalid={!timeoutValid}
                onChange={(event) => setTimeoutText(event.target.value)}
                className={clsx(DECISION_INPUT_CLASS, 'max-w-[7rem]')}
              />
              <span className="text-sm text-muted">seconds</span>
            </div>
            <p
              className={clsx(
                'text-xs',
                timeoutValid ? 'text-muted' : 'text-status-danger-600 dark:text-status-danger-400'
              )}
            >
              How long one decision may take across all providers, from {MIN_TIMEOUT_SECONDS} to {MAX_TIMEOUT_SECONDS}{' '}
              seconds.
            </p>
          </div>

          {canWrite && (
            <div className="space-y-2">
              {save.isError && (
                <p role="alert" className="text-sm text-status-danger-600 dark:text-status-danger-400">
                  {errorText(save.error)}
                </p>
              )}
              <div className="flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  onClick={submit}
                  disabled={!dirty || !timeoutValid || save.isPending}
                  className="ficus-button ficus-button-primary rounded-lg px-4 py-2 text-sm font-medium disabled:opacity-50"
                >
                  {save.isPending ? 'Saving…' : 'Save order'}
                </button>
                {dirty && (
                  <button
                    type="button"
                    onClick={() => {
                      setDraft(null)
                      setTimeoutText(null)
                      save.reset()
                    }}
                    className="ficus-button ficus-button-secondary rounded-lg px-4 py-2 text-sm font-medium"
                  >
                    Discard changes
                  </button>
                )}
                {dirty && <span className="text-xs text-muted">Saves the feature orders above too.</span>}
              </div>
            </div>
          )}
        </section>
      )}
    </div>
  )
}

const SCOPE_STATUS: Record<'squad' | 'authored', { status: string; note?: string }> = {
  squad: { status: 'Chosen per squad', note: "Set in each squad's GitHub settings." },
  authored: { status: 'Runs where you add it' },
}

/**
 * One thing decision models power: what it does, what it cost, whether it runs, and which
 * providers it asks. Only instance features have a switch here; it shows on/off and
 * `featureSwitchState` picks the auto/on/off value to save. A sub-feature is listed nested under
 * its parent's row, and can't be switched while the parent is off: it doesn't run then.
 */
export function DecisionFeatureRow({
  feature,
  parent,
  subFeatures,
  spend,
  approximate = false,
  hasProviders,
  canWrite,
  switching,
  onSwitch,
  custom,
  onCustomChange,
  children,
}: {
  feature: DecisionFeature
  /** This feature's spend over the chosen period. */
  spend?: { calls: number; costUsd: number }
  approximate?: boolean
  hasProviders: boolean
  canWrite: boolean
  switching: boolean
  onSwitch: (value: DecisionFeatureSwitch) => void
  custom: boolean
  onCustomChange: (custom: boolean) => void
  /** Set for a sub-feature: its parent's label, and whether the parent runs. */
  parent?: { label: string; on: boolean }
  /** A parent's sub-feature rows, listed nested under it. */
  subFeatures?: ReactNode[]
  children?: ReactNode
}) {
  const instance = feature.scope === 'instance'
  const featureState = featureSwitchState(feature)
  const { offByDefault, turnOn, turnOff } = featureState
  const parentOff = parent !== undefined && !parent.on
  const on = featureState.on && !parentOff
  const { status, color, note }: { status: string; color: BadgeColor; note?: string } =
    feature.scope === 'instance'
      ? {
          status: !hasProviders ? 'Needs a decision model' : on ? 'On' : 'Off',
          color: !hasProviders ? 'attention' : on ? 'success' : 'neutral',
          note:
            hasProviders && parentOff
              ? `Turn on the ${parent.label.toLowerCase()} first.`
              : offByDefault
                ? "Off by default; turn on if it's worth the cost."
                : parent
                  ? `On by default while the ${parent.label.toLowerCase()} is on.`
                  : 'On by default once a decision model is set up.',
        }
      : { ...SCOPE_STATUS[feature.scope], color: 'neutral' }
  const switchLabel = parent
    ? `Use the ${parent.label.toLowerCase()} for ${feature.label.toLowerCase()}`
    : `Use the ${feature.label.toLowerCase()}`
  return (
    <li className="space-y-3 py-3" aria-label={feature.label}>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-sm font-medium text-primary">{feature.label}</span>
            <Badge color={color}>{status}</Badge>
            {spend && spend.calls > 0 && (
              <span
                className="text-xs tabular-nums text-secondary"
                title={approximate ? SPEND_ESTIMATE_NOTE : undefined}
              >
                {formatSpend(spend.costUsd, approximate)} · {spend.calls.toLocaleString('en-US')}{' '}
                {spend.calls === 1 ? 'call' : 'calls'}
              </span>
            )}
          </div>
          <p className="mt-0.5 text-xs text-muted">
            {feature.description}
            {note ? ` ${note}` : ''}
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-3">
          {instance && (
            <label className="flex items-center gap-2 text-sm text-secondary">
              <input
                type="checkbox"
                role="switch"
                aria-label={switchLabel}
                checked={hasProviders && on}
                disabled={!canWrite || !hasProviders || parentOff || switching}
                title={parentOff && hasProviders ? `Turn on the ${parent.label.toLowerCase()} first` : undefined}
                onChange={(event) => onSwitch(event.target.checked ? turnOn : turnOff)}
                className="h-4 w-4 accent-current disabled:opacity-50"
              />
              <span className={clsx((!hasProviders || parentOff) && 'opacity-50')}>Enabled</span>
            </label>
          )}
          {hasProviders && (
            <SegmentedControl
              size="compact"
              ariaLabel={`${feature.label} order`}
              value={custom ? 'custom' : 'default'}
              disabled={!canWrite}
              onChange={(next) => onCustomChange(next === 'custom')}
              options={[
                { value: 'default', label: parent ? 'Same as parent' : 'Use default order' },
                { value: 'custom', label: 'Custom order' },
              ]}
            />
          )}
        </div>
      </div>
      {children}
      {subFeatures && subFeatures.length > 0 && (
        <ul
          aria-label={`Parts of the ${feature.label.toLowerCase()}`}
          className="ml-3 divide-y divide-th-border border-l border-th-border pl-4 sm:ml-4"
        >
          {subFeatures}
        </ul>
      )}
    </li>
  )
}

/** An editable, ordered list of providers, with the rest offered to add. */
export function ProviderOrder({
  label,
  ids,
  providers,
  disabled,
  onChange,
  emptyText,
}: {
  label: string
  ids: string[]
  providers: DecisionProviderView[]
  disabled: boolean
  onChange: (ids: string[]) => void
  emptyText: string
}) {
  const byId = new Map(providers.map((provider) => [provider.id, provider]))
  const listed = ids.filter((id) => byId.has(id))
  const unused = providers.filter((provider) => !listed.includes(provider.id))
  const move = (index: number, by: -1 | 1) => {
    const next = [...listed]
    ;[next[index], next[index + by]] = [next[index + by], next[index]]
    onChange(next)
  }

  return (
    <div className="space-y-2">
      {listed.length === 0 ? (
        <p className="ficus-inset px-3 py-2.5 text-xs text-muted">{emptyText}</p>
      ) : (
        <ol aria-label={label} className="ficus-inset divide-y divide-th-border">
          {listed.map((id, index) => {
            const provider = byId.get(id)!
            return (
              <li key={id} className="flex min-w-0 items-center gap-2 py-1.5 pl-3 pr-1.5">
                <span className="w-4 shrink-0 text-xs tabular-nums text-muted">{index + 1}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-primary">{provider.label}</span>
                  <span className="block truncate font-mono text-xs text-muted">{provider.model}</span>
                </span>
                {!provider.enabled && <Badge>Off</Badge>}
                <div className="flex shrink-0 items-center">
                  <button
                    type="button"
                    aria-label={`Move ${provider.label} up`}
                    disabled={disabled || index === 0}
                    onClick={() => move(index, -1)}
                    className="ficus-button ficus-button-ghost rounded-md p-1.5 text-muted disabled:opacity-40"
                  >
                    <ChevronDownIcon className="h-4 w-4 rotate-180" />
                  </button>
                  <button
                    type="button"
                    aria-label={`Move ${provider.label} down`}
                    disabled={disabled || index === listed.length - 1}
                    onClick={() => move(index, 1)}
                    className="ficus-button ficus-button-ghost rounded-md p-1.5 text-muted disabled:opacity-40"
                  >
                    <ChevronDownIcon className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    aria-label={`Take ${provider.label} out of ${label.toLowerCase()}`}
                    disabled={disabled}
                    onClick={() => onChange(listed.filter((other) => other !== id))}
                    className="ficus-button ficus-button-ghost rounded-md p-1.5 text-muted hover:text-status-danger-600 disabled:opacity-40"
                  >
                    <CloseIcon className="h-4 w-4" />
                  </button>
                </div>
              </li>
            )
          })}
        </ol>
      )}
      {unused.length > 0 && !disabled && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted">Add:</span>
          {unused.map((provider) => (
            <button
              key={provider.id}
              type="button"
              disabled={listed.length >= MAX_ORDER}
              onClick={() => onChange([...listed, provider.id])}
              aria-label={`Add ${provider.label} to ${label.toLowerCase()}`}
              className="ficus-button ficus-button-secondary flex items-center gap-1 rounded-md px-2 py-1 text-xs disabled:opacity-50"
            >
              <PlusIcon className="h-3 w-3" />
              {provider.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
