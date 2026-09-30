import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import clsx from 'clsx'
import { Modal } from '../Modal'
import { CheckIcon, SearchIcon } from '../icons'
import { ProviderLogo } from '../settings/ProviderDirectoryCard'
import { useStableRef } from '../../hooks/useStableRef'

export type ProviderPickerOption = { id: string; name: string; description?: string }

/** Offered directly as cards, in this order. Every other option lives under More providers. */
const PRIMARY_PROVIDER_IDS = ['anthropic', 'openai']

const TILE_CLASS = 'flex h-full w-full min-w-0 items-start gap-3 rounded-lg border p-4 text-left transition-colors'
const tileState = (selected: boolean) =>
  selected ? 'border-accent bg-selection' : 'border-panel-border bg-surface hover:bg-surface-hover'

/**
 * Onboarding's provider choice: the two most common providers as cards, and a searchable dialog
 * for the rest. `value`/`onChange` carry the same provider ids the previous `<select>` did.
 */
export function OnboardingProviderPicker({
  options,
  value,
  onChange,
}: {
  options: ProviderPickerOption[]
  value: string
  onChange: (providerId: string) => void
}) {
  const [moreOpen, setMoreOpen] = useState(false)
  const [query, setQuery] = useState('')
  const moreButtonRef = useRef<HTMLButtonElement>(null)
  const radioRefs = useRef<Array<HTMLButtonElement | null>>([])

  // A provider missing from this instance's directory simply has no card.
  const primary = PRIMARY_PROVIDER_IDS.flatMap((id) => options.filter((option) => option.id === id))
  const others = options.filter((option) => !PRIMARY_PROVIDER_IDS.includes(option.id))
  const selectedOther = others.find((option) => option.id === value)
  const checkedIndex = primary.findIndex((option) => option.id === value)
  const tileCount = primary.length + (others.length ? 1 : 0)

  if (!tileCount) return null

  const onRadioKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const step =
      event.key === 'ArrowRight' || event.key === 'ArrowDown'
        ? 1
        : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
          ? -1
          : 0
    if (!step) return
    event.preventDefault()
    const next = (index + step + primary.length) % primary.length
    onChange(primary[next]!.id)
    radioRefs.current[next]?.focus()
  }

  const closeMore = () => {
    setMoreOpen(false)
    moreButtonRef.current?.focus()
  }

  return (
    <>
      <div
        className={clsx('grid gap-3', {
          'sm:grid-cols-2': tileCount === 2,
          'sm:grid-cols-3': tileCount === 3,
        })}
      >
        {primary.length > 0 && (
          <div
            role="radiogroup"
            aria-label="Choose an AI provider"
            className={clsx('grid gap-3', primary.length > 1 && 'sm:col-span-2 sm:grid-cols-2')}
          >
            {primary.map((option, index) => (
              <ProviderChoiceCard
                key={option.id}
                ref={(element) => {
                  radioRefs.current[index] = element
                }}
                option={option}
                checked={index === checkedIndex}
                // Roving focus: the checked card (or the first) is the group's single tab stop.
                tabbable={index === Math.max(checkedIndex, 0)}
                onSelect={() => onChange(option.id)}
                onKeyDown={(event) => onRadioKeyDown(event, index)}
              />
            ))}
          </div>
        )}
        {others.length > 0 && (
          <button
            ref={moreButtonRef}
            type="button"
            aria-haspopup="dialog"
            onClick={() => {
              setQuery('')
              setMoreOpen(true)
            }}
            className={clsx(TILE_CLASS, tileState(!!selectedOther))}
          >
            <span
              aria-hidden="true"
              className={clsx(
                'flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-panel-border bg-surface-secondary',
                selectedOther ? 'text-accent-light' : 'text-secondary'
              )}
            >
              {selectedOther ? (
                <ProviderLogo providerId={selectedOther.id} className="h-5 w-5" />
              ) : (
                <SearchIcon className="h-5 w-5" />
              )}
            </span>
            <span className="min-w-0 flex-1">
              {selectedOther ? (
                <>
                  <span className="block break-words font-medium text-primary">{selectedOther.name}</span>
                  <span className="mt-0.5 block text-xs text-muted">
                    From more providers · <span className="text-accent-light">Change</span>
                  </span>
                </>
              ) : (
                <>
                  <span className="block font-medium text-primary">More providers</span>
                  <span className="mt-0.5 block text-xs text-muted">
                    Search {others.length} more {others.length === 1 ? 'option' : 'options'}
                  </span>
                </>
              )}
            </span>
            {selectedOther && <CheckIcon className="h-4 w-4 shrink-0 text-accent-light" />}
          </button>
        )}
      </div>
      <ProviderSearchModal
        isOpen={moreOpen}
        options={others}
        value={value}
        query={query}
        onQueryChange={setQuery}
        onSelect={(providerId) => {
          onChange(providerId)
          closeMore()
        }}
        onClose={closeMore}
      />
    </>
  )
}

function ProviderChoiceCard({
  ref,
  option,
  checked,
  tabbable,
  onSelect,
  onKeyDown,
}: {
  ref: (element: HTMLButtonElement | null) => void
  option: ProviderPickerOption
  checked: boolean
  tabbable: boolean
  onSelect: () => void
  onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void
}) {
  const descriptionId = useId()
  return (
    <button
      ref={ref}
      type="button"
      role="radio"
      aria-checked={checked}
      aria-label={option.name}
      aria-describedby={option.description ? descriptionId : undefined}
      tabIndex={tabbable ? 0 : -1}
      onClick={onSelect}
      onKeyDown={onKeyDown}
      data-provider-id={option.id}
      className={clsx(TILE_CLASS, tileState(checked))}
    >
      <span
        aria-hidden="true"
        className={clsx(
          'flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-panel-border bg-surface-secondary',
          checked ? 'text-accent-light' : 'text-primary'
        )}
      >
        <ProviderLogo providerId={option.id} className="h-5 w-5" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block break-words font-medium text-primary">{option.name}</span>
        {option.description && (
          <span id={descriptionId} className="mt-0.5 block text-xs text-muted">
            {option.description}
          </span>
        )}
      </span>
      {checked && <CheckIcon className="h-4 w-4 shrink-0 text-accent-light" />}
    </button>
  )
}

function ProviderSearchModal({
  isOpen,
  options,
  value,
  query,
  onQueryChange,
  onSelect,
  onClose,
}: {
  isOpen: boolean
  options: ProviderPickerOption[]
  value: string
  query: string
  onQueryChange: (query: string) => void
  onSelect: (providerId: string) => void
  onClose: () => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const onCloseRef = useStableRef(onClose)
  const needle = query.trim().toLowerCase()
  const matches = needle
    ? options.filter((option) => `${option.name} ${option.id}`.toLowerCase().includes(needle))
    : options

  // Runs after Modal's own open effect (parents' effects follow their children's), which focuses
  // the dialog container; move focus on into the search field.
  useEffect(() => {
    if (isOpen) inputRef.current?.focus()
  }, [isOpen])

  useEffect(() => {
    if (!isOpen) return
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopImmediatePropagation()
      onCloseRef.current()
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => document.removeEventListener('keydown', onKeyDown, true)
  }, [isOpen, onCloseRef])

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="More providers">
      <div className="flex min-h-0 flex-col gap-3">
        <div className="relative shrink-0">
          <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-muted">
            <SearchIcon className="h-4 w-4" />
          </span>
          <input
            ref={inputRef}
            type="search"
            aria-label="Search providers"
            placeholder="Search providers…"
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Enter') return
              event.preventDefault()
              if (matches[0]) onSelect(matches[0].id)
            }}
            className="ficus-field w-full py-2 pl-9 pr-3 text-sm"
          />
        </div>
        {matches.length ? (
          <ul aria-label="Providers" className="-mx-1 max-h-[min(24rem,55vh)] overflow-y-auto px-1">
            {matches.map((option) => {
              const selected = option.id === value
              return (
                <li key={option.id}>
                  <button
                    type="button"
                    aria-current={selected || undefined}
                    onClick={() => onSelect(option.id)}
                    className={clsx(
                      'flex w-full min-w-0 items-center gap-3 rounded-md px-2 py-2 text-left transition-colors',
                      selected ? 'bg-selection' : 'hover:bg-surface-hover'
                    )}
                  >
                    <span
                      aria-hidden="true"
                      className={clsx('shrink-0', selected ? 'text-accent-light' : 'text-secondary')}
                    >
                      <ProviderLogo providerId={option.id} className="h-5 w-5" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span
                        className={clsx(
                          'block break-words text-sm font-medium',
                          selected ? 'text-accent-light' : 'text-primary'
                        )}
                      >
                        {option.name}
                      </span>
                      {option.description && (
                        <span className="block break-words text-xs text-muted">{option.description}</span>
                      )}
                    </span>
                    {selected && <CheckIcon className="h-4 w-4 shrink-0 text-accent-light" />}
                  </button>
                </li>
              )
            })}
          </ul>
        ) : (
          <p role="status" className="px-1 py-4 text-sm text-muted">
            No providers match “{query.trim()}”.
          </p>
        )}
      </div>
    </Modal>
  )
}
