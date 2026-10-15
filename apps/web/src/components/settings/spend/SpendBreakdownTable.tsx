import { SPEND_DIMENSIONS, type SpendBreakdown, type SpendDimension } from '@ficus/shared'
import { SelectionPopup } from '../../ThemedPopup'
import { DIMENSION_LABELS, formatSpend, formatTokens, formatUsd } from './spendUi'

const NONE = 'none'
const dimensionOptions = SPEND_DIMENSIONS.map((dimension) => ({ value: dimension, label: DIMENSION_LABELS[dimension] }))

function DimensionPicker<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: T
  options: readonly { value: T; label: string }[]
  onChange: (value: T) => void
}) {
  return (
    <SelectionPopup
      label={label}
      value={value}
      options={options}
      onChange={onChange}
      className="ficus-field px-2 py-1 text-sm"
    >
      {options.find((option) => option.value === value)?.label ?? value}
    </SelectionPopup>
  )
}

/**
 * Spend grouped by one dimension (and optionally split by a second), largest first. Each row can narrow the
 * whole view to its value.
 */
export function SpendBreakdownTable({
  breakdown,
  title,
  showList,
  onFilter,
  by,
  by2,
  onByChange,
  onBy2Change,
  loading,
}: {
  breakdown?: SpendBreakdown
  title: string
  showList: boolean
  onFilter: (dimension: SpendDimension, key: string | null) => void
  /** With pickers: the main table. Without: a fixed "top" list. */
  by?: SpendDimension
  by2?: SpendDimension
  onByChange?: (dimension: SpendDimension) => void
  onBy2Change?: (dimension: SpendDimension | undefined) => void
  loading?: boolean
}) {
  const rows = breakdown?.rows ?? []
  const total = rows.reduce((sum, row) => sum + row.billedUsd, 0)
  const headingId = `spend-breakdown-${title.replace(/\W+/g, '-').toLowerCase()}`
  const dimension = breakdown?.by ?? by
  const second = breakdown?.by2
  return (
    <section aria-labelledby={headingId} className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <h3 id={headingId} className="text-sm font-medium text-primary">
          {title}
        </h3>
        {by && onByChange && (
          <>
            <DimensionPicker label="Group by" value={by} options={dimensionOptions} onChange={onByChange} />
            <span className="text-xs text-muted">then</span>
            <DimensionPicker
              label="Then by"
              value={by2 ?? NONE}
              options={[{ value: NONE, label: 'Nothing' }, ...dimensionOptions.filter((option) => option.value !== by)]}
              onChange={(value) => onBy2Change?.(value === NONE ? undefined : (value as SpendDimension))}
            />
          </>
        )}
      </div>
      {rows.length === 0 ? (
        <p className="text-sm text-muted">{loading ? 'Loading…' : 'No spend in this period.'}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="ficus-table w-full text-sm">
            <thead>
              <tr>
                <th scope="col" className="text-left">
                  {dimension ? DIMENSION_LABELS[dimension] : ''}
                </th>
                {second && (
                  <th scope="col" className="text-left">
                    {DIMENSION_LABELS[second]}
                  </th>
                )}
                <th scope="col" className="text-right">
                  Calls
                </th>
                <th scope="col" className="text-right">
                  Tokens
                </th>
                <th scope="col" className="text-right">
                  Billed
                </th>
                {showList && (
                  <th scope="col" className="text-right">
                    At list price
                  </th>
                )}
                <th scope="col" className="text-right">
                  Share
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={`${row.key ?? ''}|${row.key2 ?? ''}`}>
                  <td>
                    {dimension ? (
                      <button
                        type="button"
                        className="ficus-button ficus-button-link text-left"
                        title={`Show only ${row.label}`}
                        onClick={() => onFilter(dimension, row.key)}
                      >
                        {row.label}
                      </button>
                    ) : (
                      row.label
                    )}
                  </td>
                  {second && (
                    <td>
                      <button
                        type="button"
                        className="ficus-button ficus-button-link text-left"
                        title={`Show only ${row.label2}`}
                        onClick={() => onFilter(second, row.key2 ?? null)}
                      >
                        {row.label2}
                      </button>
                    </td>
                  )}
                  <td className="text-right tabular-nums">{row.calls.toLocaleString('en-US')}</td>
                  <td className="text-right tabular-nums">{formatTokens(row.tokens)}</td>
                  <td className="text-right tabular-nums">{formatSpend(row.billedUsd, row.approximate)}</td>
                  {showList && <td className="text-right tabular-nums text-muted">{formatUsd(row.listUsd)}</td>}
                  <td className="text-right tabular-nums text-muted">
                    {total > 0 ? `${Math.round((row.billedUsd / total) * 100)}%` : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {breakdown?.truncated && <p className="mt-1 text-xs text-muted">Showing the largest {rows.length}.</p>}
        </div>
      )}
    </section>
  )
}
