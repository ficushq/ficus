import { useMemo, useState } from 'react'
import { MEMORY_SOURCE_TYPE_METADATA } from '@ficus/shared'
import { useQuery } from '@tanstack/react-query'
import { queries } from '../../queryOptions'
import type { SearchMemoryParams } from '../../api/memory'

const SENSITIVITIES = ['public', 'internal', 'restricted', 'confidential'] as const

export function MemorySearchPanel({ squadId }: { squadId: string }) {
  const [query, setQuery] = useState('')
  const [submitted, setSubmitted] = useState('')
  const [sourceSquadIds, setSourceSquadIds] = useState<string[]>([])
  const [sourceType, setSourceType] = useState('')
  const [sensitivity, setSensitivity] = useState('')

  const { data: inboundGrants = [] } = useQuery(queries.squads.grants.inbound(squadId))
  const { data: allSquads = [] } = useQuery(queries.squads.list('active'))

  const sourceOptions = useMemo(() => {
    const ids = new Set<string>([squadId, ...inboundGrants.map((grant) => grant.sourceSquadId)])
    return [...ids].map((id) => ({ id, name: allSquads.find((squad) => squad.id === id)?.name ?? id.slice(0, 8) }))
  }, [allSquads, inboundGrants, squadId])

  const searchParams: SearchMemoryParams = {
    query: submitted,
    sourceSquadIds:
      sourceOptions.length > 1 && sourceSquadIds.length
        ? sourceSquadIds.filter((id) => sourceOptions.some((option) => option.id === id))
        : undefined,
    sourceTypes: sourceType ? [sourceType] : undefined,
    sensitivity: sensitivity || undefined,
  }
  const results = useQuery({
    ...queries.squadMemory.search(squadId, searchParams),
    enabled: submitted.trim().length > 0,
  })

  return (
    <section className="shrink-0 mb-4 space-y-3 max-h-[45%] overflow-y-auto">
      <form
        onSubmit={(event) => {
          event.preventDefault()
          setSubmitted(query)
        }}
        className="flex gap-2"
      >
        <input
          type="search"
          placeholder="Search memory…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          aria-label="Search memory"
          className="ficus-field min-w-0 flex-1 rounded-xl border border-th-border bg-surface px-3 py-2 text-sm"
        />
        <button type="submit" className="ficus-button ficus-button-primary rounded-xl px-4 py-2 text-sm font-medium">
          Search
        </button>
      </form>

      <div className="flex flex-wrap items-center gap-x-5 gap-y-3 text-xs text-secondary">
        {sourceOptions.length > 1 && (
          <fieldset className="flex flex-wrap items-center gap-2">
            <legend className="sr-only">Source squads</legend>
            <span aria-hidden="true">Source squad</span>
            {sourceOptions.map((option) => (
              <label
                key={option.id}
                className="flex cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 hover:bg-surface-hover"
              >
                <input
                  type="checkbox"
                  checked={sourceSquadIds.includes(option.id)}
                  onChange={(event) =>
                    setSourceSquadIds((ids) =>
                      event.target.checked ? [...ids, option.id] : ids.filter((id) => id !== option.id)
                    )
                  }
                />
                {option.name}
              </label>
            ))}
          </fieldset>
        )}
        <label className="flex items-center gap-2">
          Source type
          <select
            value={sourceType}
            onChange={(event) => setSourceType(event.target.value)}
            className="ficus-field rounded-lg border-0 bg-surface-hover px-2 py-1.5"
          >
            <option value="">Any</option>
            {MEMORY_SOURCE_TYPE_METADATA.map((type) => (
              <option key={type.value} value={type.value}>
                {type.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2">
          Max sensitivity
          <select
            value={sensitivity}
            onChange={(event) => setSensitivity(event.target.value)}
            className="ficus-field rounded-lg border-0 bg-surface-hover px-2 py-1.5"
          >
            <option value="">Any</option>
            {SENSITIVITIES.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>
      </div>

      <ul className="space-y-1" aria-busy={results.isFetching}>
        {results.isLoading && <li className="py-2 text-sm text-muted">Searching memory…</li>}
        {results.isError && <li className="py-2 text-sm text-muted">Couldn’t search memory. Please try again.</li>}
        {(results.data ?? []).map((result) => {
          const squadName =
            sourceOptions.find((option) => option.id === result.sourceSquadId)?.name ?? result.sourceSquadId.slice(0, 8)
          return (
            <li key={`${result.documentId}-${result.chunkIndex}`} className="border-b border-panel-border py-3 text-sm">
              <div className="font-medium">
                {result.path ?? '(no path)'}
                {result.title ? ` — ${result.title}` : ''}
              </div>
              <div className="text-xs text-muted">
                <span>{squadName}</span> · <span>{result.sourceType ?? 'unknown'}</span> ·{' '}
                <span>{result.sensitivity}</span> · <span>score {result.score?.toFixed?.(3) ?? result.score}</span>
              </div>
              <pre className="mt-1 whitespace-pre-wrap text-xs">{result.snippet}</pre>
            </li>
          )
        })}
        {results.isSuccess && !results.isFetching && (results.data ?? []).length === 0 && submitted && (
          <li className="text-sm text-muted">No matching documents.</li>
        )}
      </ul>
    </section>
  )
}
