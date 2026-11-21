import { useState } from 'react'
import { providerLabel, type ModelCatalogEntry } from '@ficus/shared'
import type { ModelTierConfig } from '../api/config'
import { parseDisplayModelSpec } from '../lib/displayModelSpec'
import { useAdjustOnChange } from '../hooks/useAdjustOnChange'

/**
 * A model priority-list editor over the model catalog: provider, model and reasoning per position,
 * reordering and removal. It reports every committed change through `onSave`; callers decide whether
 * that saves immediately (model tiers) or updates a draft (an agent's custom model).
 */
const EFFORTS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
function splitChainEntry(entry: string): { provider: string; model: string; effort: string } {
  const parsed = parseDisplayModelSpec(entry)
  return { provider: parsed.provider, model: parsed.modelId, effort: parsed.thinkingLevel ?? 'off' }
}
export function TierChainEditor({
  tier,
  providers,
  onSave,
  derivedFallbacks = [],
  catalog = [],
  disabled = false,
  disabledProviders = [],
}: {
  tier: ModelTierConfig
  providers: string[]
  onSave: (tier: ModelTierConfig) => void
  derivedFallbacks?: string[]
  catalog?: ModelCatalogEntry[]
  disabled?: boolean
  /** Providers turned off globally: their entries stay editable but are shown muted. */
  disabledProviders?: string[]
}) {
  const [entries, setEntries] = useState(() => tier.chain.split(',').filter(Boolean))
  const [customRows, setCustomRows] = useState<Set<number>>(() => new Set())
  const [dragged, setDragged] = useState<number | null>(null)
  useAdjustOnChange([tier.chain], () => setEntries(tier.chain.split(',').filter(Boolean)))
  const commit = (next: string[]) => {
    if (disabled) return
    setEntries(next)
    onSave({ ...tier, chain: next.join(',') })
  }
  const updatePart = (index: number, part: 'provider' | 'model' | 'effort', value: string, save = false) => {
    const parsed = splitChainEntry(entries[index])
    parsed[part] = value
    const next = entries.map((entry, i) =>
      i === index ? `${parsed.provider}:${parsed.model}:${parsed.effort}` : entry
    )
    if (save) commit(next)
    else setEntries(next)
  }
  return (
    <fieldset disabled={disabled} className="mt-4 min-w-0 space-y-3">
      {entries.map((entry, index) => {
        const parsed = splitChainEntry(entry)
        const providerOptions = [...new Set([...providers, ...catalog.map((model) => model.provider), parsed.provider])]
          .filter(Boolean)
          .sort()
        const models = catalog.filter((model) => model.provider === parsed.provider)
        const metadata = models.find((model) => model.id === parsed.model)
        const custom = customRows.has(index) || !metadata
        const providerDisabled = disabledProviders.includes(parsed.provider)
        const move = (to: number) => {
          const next = [...entries]
          const [item] = next.splice(index, 1)
          next.splice(to, 0, item)
          setCustomRows(new Set())
          commit(next)
        }
        return (
          <div
            key={index}
            data-drop-scope="reorder"
            draggable={!disabled}
            onDragStart={() => setDragged(index)}
            onDragOver={(event) => event.preventDefault()}
            onDrop={() => {
              if (dragged == null || dragged === index) return
              const next = [...entries]
              const [item] = next.splice(dragged, 1)
              next.splice(index, 0, item)
              setDragged(null)
              commit(next)
            }}
            className={`rounded-xl bg-surface-secondary/60 p-3 space-y-3${providerDisabled ? ' opacity-60' : ''}`}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-medium text-muted">
                {index === 0 ? 'Primary model' : `Fallback ${index}`}
                {providerDisabled && (
                  <span
                    title="This provider is disabled in provider settings, so this entry is skipped."
                    className="ml-2 rounded bg-surface px-1.5 py-0.5 text-xs text-muted"
                  >
                    Disabled
                  </span>
                )}
              </span>
              <div className="flex gap-1">
                <button
                  type="button"
                  disabled={disabled || index === 0}
                  aria-label={`Move ${tier.label} model ${index + 1} up`}
                  onClick={() => move(index - 1)}
                  className="ficus-button ficus-button-ghost px-2 disabled:opacity-30"
                >
                  ↑
                </button>
                <button
                  type="button"
                  disabled={disabled || index === entries.length - 1}
                  aria-label={`Move ${tier.label} model ${index + 1} down`}
                  onClick={() => move(index + 1)}
                  className="ficus-button ficus-button-ghost px-2 disabled:opacity-30"
                >
                  ↓
                </button>
                <button
                  type="button"
                  aria-label={`Remove ${tier.label} model ${index + 1}`}
                  className="ficus-button ficus-button-danger py-1 px-2 text-xs"
                  onClick={() => commit(entries.filter((_, i) => i !== index))}
                >
                  Remove
                </button>
              </div>
            </div>
            <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)_minmax(0,.75fr)]">
              <label className="min-w-0 space-y-1 text-xs text-muted">
                <span>Provider</span>
                <select
                  aria-label={`${tier.label} provider position ${index + 1}`}
                  value={parsed.provider}
                  onChange={(event) => updatePart(index, 'provider', event.target.value, true)}
                  className="ficus-field w-full min-w-0 bg-surface p-2 text-sm"
                >
                  {providerOptions.map((provider) => (
                    <option key={provider} value={provider}>
                      {providerLabel(provider)}
                    </option>
                  ))}
                </select>
              </label>
              <div className="min-w-0 space-y-1">
                <label className="block text-xs text-muted">
                  <span className="block mb-1">Model</span>
                  <select
                    aria-label={`${tier.label} model selection position ${index + 1}`}
                    value={custom ? '__custom__' : parsed.model}
                    className="ficus-field w-full min-w-0 bg-surface p-2 text-sm"
                    onChange={(event) => {
                      const value = event.target.value
                      setCustomRows((previous) => {
                        const next = new Set(previous)
                        if (value === '__custom__') next.add(index)
                        else next.delete(index)
                        return next
                      })
                      if (value !== '__custom__') updatePart(index, 'model', value, true)
                    }}
                  >
                    {models.map((model) => (
                      <option key={model.id} value={model.id}>
                        {model.name}
                      </option>
                    ))}
                    <option value="__custom__">Custom model ID…</option>
                  </select>
                </label>
                {custom && (
                  <input
                    aria-label={`${tier.label} model position ${index + 1}`}
                    value={parsed.model}
                    onChange={(event) => updatePart(index, 'model', event.target.value)}
                    onBlur={() => commit(entries)}
                    placeholder="Enter model ID"
                    className="ficus-field w-full min-w-0 bg-surface p-2 font-mono text-sm"
                  />
                )}
                {metadata && (
                  <p className="text-xs text-muted">
                    {Math.round(metadata.contextWindow / 1000)}k context
                    {metadata.input.includes('image') ? ' · Images' : ''}
                    {metadata.reasoning ? ' · Reasoning' : ''}
                  </p>
                )}
              </div>
              <label className="min-w-0 space-y-1 text-xs text-muted">
                <span>Reasoning</span>
                <select
                  aria-label={`${tier.label} effort position ${index + 1}`}
                  value={parsed.effort}
                  onChange={(event) => {
                    updatePart(index, 'effort', event.target.value, true)
                  }}
                  className="ficus-field w-full min-w-0 bg-surface p-2 text-sm"
                >
                  {EFFORTS.map((effort) => (
                    <option key={effort}>{effort}</option>
                  ))}
                </select>
              </label>
            </div>
          </div>
        )
      })}
      {derivedFallbacks.map((fallback, index) => (
        <div key={fallback} className="flex flex-wrap items-center gap-2 px-3 py-1.5 text-xs text-muted">
          <span className="w-6">{entries.length + index + 1}.</span>
          <code className="flex-1">{fallback}</code>
          <span className="rounded bg-accent/10 px-2 py-0.5 text-xs font-medium text-accent-light">via OpenRouter</span>
        </div>
      ))}
      <button
        onClick={() => setEntries([...entries, `${providers[0] ?? 'provider'}:model:medium`])}
        className="ficus-button ficus-button-ghost px-2 py-1 text-sm"
      >
        + Add provider position
      </button>
    </fieldset>
  )
}
