import { useId, useState } from 'react'
import clsx from 'clsx'
import { PERMISSION_CATALOG, permissionMatches } from '@ficus/shared'
import { ChevronDownIcon, SearchIcon } from '../icons'

interface Props {
  value: string[]
  onChange: (next: string[]) => void
  disabled?: boolean
}

const GROUPS = [...new Set(PERMISSION_CATALOG.map((entry) => entry.resource))].sort().map((resource) => ({
  resource,
  label:
    (
      {
        ai: 'AI services',
        amtp: 'Federation',
        env: 'Environment',
        ssh: 'SSH',
        'provider-auth': 'AI provider accounts',
        workstreams: 'Work streams',
      } as Record<string, string>
    )[resource] ?? resource.replaceAll('-', ' ').replace(/^./, (letter) => letter.toUpperCase()),
  entries: PERMISSION_CATALOG.filter((entry) => entry.resource === resource).sort((a, b) =>
    a.permission.localeCompare(b.permission)
  ),
}))
const KNOWN = new Set<string>(PERMISSION_CATALOG.map((entry) => entry.permission))

export function PermissionPicker({ value, onChange, disabled = false }: Props) {
  const id = useId()
  const [search, setSearch] = useState('')
  const [selectedOnly, setSelectedOnly] = useState(false)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const query = search.trim().toLowerCase()
  const selected = new Set(value)
  const included = (permission: string) =>
    value.find((held) => held !== permission && permissionMatches(held, permission))
  const extra = value.filter((permission) => !KNOWN.has(permission))
  const groups = GROUPS.map((group) => ({
    ...group,
    entries: group.entries.filter(
      (entry) =>
        (!selectedOnly || value.some((held) => permissionMatches(held, entry.permission))) &&
        (!query || `${group.label} ${entry.permission} ${entry.description}`.toLowerCase().includes(query))
    ),
  })).filter((group) => group.entries.length)

  // Keep exact grants and existing wildcards intact. Selecting all current leaves
  // must never silently grant future permissions via a resource wildcard.
  const toggle = (permission: string) =>
    onChange(selected.has(permission) ? value.filter((held) => held !== permission) : [...value, permission])

  return (
    <fieldset disabled={disabled} className="min-w-0 space-y-3 disabled:opacity-60">
      <legend className="sr-only">Permissions</legend>
      <div className="relative">
        <SearchIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
        <input
          type="search"
          aria-label="Search permissions"
          placeholder="Search permissions…"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          className="ficus-field w-full rounded-lg py-2 pl-9 pr-3 text-sm"
        />
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
        <span aria-live="polite">{value.length} selected</span>
        <label className="flex cursor-pointer items-center gap-2">
          <input
            type="checkbox"
            checked={selectedOnly}
            onChange={(event) => setSelectedOnly(event.target.checked)}
            className="h-4 w-4 rounded border-th-border accent-accent"
          />
          Show selected only
        </label>
      </div>
      <div className="max-h-[32rem] overflow-y-auto rounded-xl border border-panel-border divide-y divide-panel-border">
        {groups.map((group) => {
          const open = !!query || selectedOnly || expanded.has(group.resource)
          const count = GROUPS.find((item) => item.resource === group.resource)!.entries.filter((entry) =>
            value.some((held) => permissionMatches(held, entry.permission))
          ).length
          return (
            <div key={group.resource}>
              <button
                type="button"
                aria-expanded={open}
                aria-controls={`${id}-${group.resource}`}
                onClick={() =>
                  setExpanded((current) => {
                    const next = new Set(current)
                    if (next.has(group.resource)) next.delete(group.resource)
                    else next.add(group.resource)
                    return next
                  })
                }
                className="ficus-button ficus-button-ghost flex w-full items-center gap-3 px-4 py-3 text-left"
              >
                <span className="flex-1 text-sm font-medium text-primary">{group.label}</span>
                {count > 0 && (
                  <span className="rounded-full bg-accent/10 px-2 py-0.5 text-xs text-accent-light">
                    {count} selected
                  </span>
                )}
                <ChevronDownIcon className={clsx('h-4 w-4 text-muted transition-transform', open && 'rotate-180')} />
              </button>
              {open && (
                <div
                  id={`${id}-${group.resource}`}
                  className="border-t border-panel-border px-4 divide-y divide-panel-border/50"
                >
                  {group.entries.map((entry) => {
                    const parent = included(entry.permission)
                    return (
                      <label
                        key={entry.permission}
                        className={clsx('flex items-start gap-3 py-3', parent ? 'cursor-default' : 'cursor-pointer')}
                      >
                        <input
                          type="checkbox"
                          aria-label={entry.permission}
                          aria-describedby={`${id}-${entry.permission}`}
                          checked={selected.has(entry.permission) || !!parent}
                          disabled={!!parent}
                          onChange={() => toggle(entry.permission)}
                          className="mt-0.5 h-4 w-4 shrink-0 rounded border-th-border accent-accent"
                        />
                        <span className="min-w-0">
                          <span className="block break-all font-mono text-xs text-primary">{entry.permission}</span>
                          <span
                            id={`${id}-${entry.permission}`}
                            className="mt-1 block text-sm leading-relaxed text-muted"
                          >
                            {entry.description}
                          </span>
                          {parent && <span className="mt-1 block text-xs text-muted">Included by {parent}</span>}
                        </span>
                      </label>
                    )
                  })}
                </div>
              )}
            </div>
          )
        })}
        {groups.length === 0 && <p className="px-4 py-6 text-sm text-muted">No matching permissions.</p>}
      </div>
      {extra.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs text-muted">
            Additional grants are kept until removed. Wildcards include future permissions; unrecognized names may have
            no effect.
          </p>
          {extra.map((permission) => (
            <div
              key={permission}
              className="flex items-start justify-between gap-3 rounded-lg border border-panel-border px-3 py-2"
            >
              <code className="break-all text-xs text-secondary">{permission}</code>
              <button
                type="button"
                aria-label={`Remove ${permission}`}
                onClick={() => onChange(value.filter((held) => held !== permission))}
                className="ficus-button ficus-button-danger px-2 py-1 shrink-0 text-xs"
              >
                Remove
              </button>
            </div>
          ))}
        </div>
      )}
    </fieldset>
  )
}
