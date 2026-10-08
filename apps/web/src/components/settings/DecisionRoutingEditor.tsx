import { useState } from 'react'
import clsx from 'clsx'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  DECISION_PURPOSE_INFO,
  DECISION_PURPOSES,
  DECISION_TIMEOUT_MAX_MS,
  type DecisionProviderView,
  type DecisionPurpose,
  type DecisionRouting,
} from '@ficus/shared'
import { setDecisionRouting } from '../../api/decisions'
import { decisionQueryKeys } from '../../queryKeys'
import type { DecisionSettings } from '../../api/decisions'
import { Badge } from '../Badge'
import { SegmentedControl } from '../SegmentedControl'
import { ChevronDownIcon, CloseIcon, PlusIcon } from '../icons'
import { DECISION_INPUT_CLASS } from './DecisionField'
import { errorText } from './decisionUi'

const MIN_TIMEOUT_SECONDS = 0.25
const MAX_TIMEOUT_SECONDS = DECISION_TIMEOUT_MAX_MS / 1000
/** Core's routing schema caps each order at this many providers. */
const MAX_ORDER = 8

/**
 * Which decision providers each purpose asks, first to last, and how long to wait in all.
 * Edits stay a local draft until saved, so reordering never half-applies.
 */
export function DecisionRoutingEditor({
  providers,
  routing,
  canWrite,
}: {
  providers: DecisionProviderView[]
  routing: DecisionRouting
  canWrite: boolean
}) {
  const queryClient = useQueryClient()
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

  return (
    <section aria-labelledby="decision-routing-heading" className="space-y-5">
      <div>
        <h4 id="decision-routing-heading" className="text-sm font-medium text-secondary">
          Order
        </h4>
        <p className="mt-0.5 text-xs text-muted">
          Ficus asks providers from the top; the first to answer in time wins. One that fails is asked last for the next
          30 seconds.
        </p>
      </div>

      <div className="space-y-2">
        <h5 className="text-xs font-medium text-secondary">Default order</h5>
        <ProviderOrder
          label="Default order"
          ids={current.default}
          providers={providers}
          disabled={!canWrite}
          onChange={(ids) => edit((routing) => ({ ...routing, default: ids }))}
          emptyText="No order yet: every enabled provider is asked, in the order you added them."
        />
      </div>

      <div className="space-y-4">
        <div>
          <h5 className="text-xs font-medium text-secondary">By purpose</h5>
          <p className="mt-0.5 text-xs text-muted">Give a feature its own order, or let it use the default.</p>
        </div>
        <ul className="divide-y divide-th-border">
          {DECISION_PURPOSES.map((purpose) => {
            const info = DECISION_PURPOSE_INFO[purpose]
            const ids = current.purposes[purpose]
            const custom = ids !== undefined
            return (
              <li key={purpose} className="space-y-3 py-3 first:pt-0 last:pb-0">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0">
                    <p className="text-sm text-primary">{info.label}</p>
                    <p className="text-xs text-muted">{info.description}</p>
                  </div>
                  <SegmentedControl
                    size="compact"
                    ariaLabel={`${info.label} order`}
                    value={custom ? 'custom' : 'default'}
                    disabled={!canWrite}
                    onChange={(next) => setPurpose(purpose, next === 'custom' ? [...current.default] : undefined)}
                    options={[
                      { value: 'default', label: 'Use default order' },
                      { value: 'custom', label: 'Custom order' },
                    ]}
                  />
                </div>
                {custom && (
                  <ProviderOrder
                    label={`${info.label} order`}
                    ids={ids}
                    providers={providers}
                    disabled={!canWrite}
                    onChange={(next) => setPurpose(purpose, next)}
                    emptyText="Empty, so it uses the default order."
                  />
                )}
              </li>
            )
          })}
        </ul>
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
          </div>
        </div>
      )}
    </section>
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
