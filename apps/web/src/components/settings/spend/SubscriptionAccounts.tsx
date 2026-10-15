import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { subscriptionPlansFor, type SpendSubscriptionLine } from '@ficus/shared'
import { updateProviderAccount } from '../../../api/providerAuth'
import { queryKeys, spendQueryKeys } from '../../../queryKeys'
import { Badge } from '../../Badge'
import { SelectionPopup } from '../../ThemedPopup'
import { formatUsd } from './spendUi'

const UNKNOWN = 'unknown'

function planHint(line: SpendSubscriptionLine): string | null {
  if (line.detectedPlan === 'max' && !line.plan) return 'Claude Code reports Max: pick 5x or 20x.'
  if (line.needsChoice && !line.plan) return 'Plan unknown: no fee is counted until you choose one or set a price.'
  if (line.needsChoice) return 'This plan has no list price: set what you pay to count its fee.'
  return null
}

function SubscriptionRow({ line, canWrite }: { line: SpendSubscriptionLine; canWrite: boolean }) {
  const client = useQueryClient()
  const plans = subscriptionPlansFor(line.provider)
  const [price, setPrice] = useState(
    line.priceSource === 'custom' && line.monthlyPriceUsd !== null ? String(line.monthlyPriceUsd) : ''
  )
  const save = useMutation({
    mutationFn: (subscription: { plan?: string | null; monthlyPriceUsd?: number | null }) =>
      updateProviderAccount(line.provider, line.accountId, { subscription }),
    onSettled: async () => {
      await Promise.all([
        client.invalidateQueries({ queryKey: spendQueryKeys.all }),
        client.invalidateQueries({ queryKey: queryKeys.providerAuth.all }),
      ])
    },
  })
  const defaultPrice = line.plan ? plans?.[line.plan]?.monthlyUsd : undefined
  const planOptions = [
    { value: UNKNOWN, label: line.planSource === 'manual' ? 'Use the detected plan' : 'Unknown' },
    ...Object.entries(plans ?? {}).map(([value, plan]) => ({
      value,
      label: plan.monthlyUsd === null ? plan.label : `${plan.label} · ${formatUsd(plan.monthlyUsd)}/mo`,
    })),
  ]
  const hint = planHint(line)
  return (
    <li className="space-y-2 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-primary">{line.label}</span>
        {line.planSource === 'detected' && (
          <Badge color="neutral" title="Reported by the provider">
            Detected
          </Badge>
        )}
        {line.planSource === 'manual' && (
          <Badge color="accent-1" title="Chosen in Settings">
            Set by you
          </Badge>
        )}
        <span className="text-sm text-secondary">
          {line.planLabel ?? 'Plan unknown'}
          {line.monthlyPriceUsd !== null && ` · ${formatUsd(line.monthlyPriceUsd)}/month`}
          {line.priceSource === 'custom' && ' (your price)'}
        </span>
      </div>
      {hint && <p className="text-xs text-status-attention-500">{hint}</p>}
      {canWrite && (
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            const trimmed = price.trim()
            save.mutate({ monthlyPriceUsd: trimmed === '' ? null : Number(trimmed) })
          }}
        >
          {plans && (
            <label className="space-y-1 text-xs text-secondary">
              <span className="block">Plan</span>
              <SelectionPopup
                label={`Plan for ${line.label}`}
                value={line.plan ?? UNKNOWN}
                options={planOptions}
                disabled={save.isPending}
                onChange={(value) => save.mutate({ plan: value === UNKNOWN ? null : value })}
                className="ficus-field block min-w-48 px-2 py-1 text-left text-sm"
                width={260}
              >
                {line.planLabel ?? 'Unknown'}
              </SelectionPopup>
            </label>
          )}
          <label className="space-y-1 text-xs text-secondary">
            <span className="block">Monthly price (USD)</span>
            <input
              className="ficus-field block w-32 px-2 py-1 text-sm"
              type="number"
              min="0"
              step="0.01"
              inputMode="decimal"
              placeholder={defaultPrice != null ? String(defaultPrice) : 'Price'}
              value={price}
              onChange={(event) => setPrice(event.target.value)}
              aria-label={`Monthly price for ${line.label}`}
            />
          </label>
          <button className="ficus-button ficus-button-secondary px-3 py-1 text-sm" disabled={save.isPending}>
            {save.isPending ? 'Saving…' : 'Save price'}
          </button>
          {save.isError && (
            <p role="alert" className="w-full text-sm text-status-danger-400">
              {save.error.message}
            </p>
          )}
        </form>
      )}
    </li>
  )
}

/** Each subscription account's plan and monthly price: detected where the provider says, else chosen here. */
export function SubscriptionAccounts({
  subscriptions,
  feesIncluded,
  canWrite,
}: {
  subscriptions: SpendSubscriptionLine[]
  feesIncluded: boolean
  canWrite: boolean
}) {
  return (
    <section
      id="spend-subscriptions"
      aria-labelledby="spend-subscriptions-heading"
      className="space-y-2"
      data-setting-target="spend-subscriptions"
    >
      <h3 id="spend-subscriptions-heading" className="text-sm font-medium text-primary">
        Subscriptions
      </h3>
      <p className="text-xs text-secondary">
        Calls on a subscription bill $0 each; its monthly fee counts once per calendar month instead, by day for part of
        a month. Plans are detected from the provider where it says (ChatGPT, and Claude Code except Max 5x vs 20x);
        leave the price empty to use the plan’s list price.
      </p>
      {!feesIncluded ? (
        <p className="text-sm text-muted">Clear the filters to see subscriptions.</p>
      ) : subscriptions.length === 0 ? (
        <p className="text-sm text-muted">No subscription accounts (ChatGPT or Claude sign-ins) are connected.</p>
      ) : (
        <ul className="divide-y divide-th-border border-y border-th-border">
          {subscriptions.map((line) => (
            <SubscriptionRow key={`${line.provider}/${line.accountId}`} line={line} canWrite={canWrite} />
          ))}
        </ul>
      )}
    </section>
  )
}
