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

/** Amounts, counts and shares never break inside (a "≈" stays with its amount), with a gap before each. */
const FIGURE = 'whitespace-nowrap pl-3 text-right tabular-nums'
/** Calls and tokens get their own columns from `sm` up; on a phone they sit under the row's label. */
const WIDE_ONLY = 'hidden sm:table-cell'

const countLabel = (count: number, one: string, many: string) =>
  `${count.toLocaleString('en-US')} ${count === 1 ? one : many}`

/**
 * Spend grouped by one dimension (and optionally split by a second), largest first. Each row can narrow the
 * whole view to its value. The table never widens the page: it fits a phone, and scrolls inside its own
 * container when a second dimension or the list price makes it wider.
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
    <section aria-labelledby={headingId} className="min-w-0 space-y-2">
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
        <div className="max-w-full overflow-x-auto">
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
                <th scope="col" className={`${FIGURE} ${WIDE_ONLY}`}>
                  Calls
                </th>
                <th scope="col" className={`${FIGURE} ${WIDE_ONLY}`}>
                  Tokens
                </th>
                <th scope="col" className={FIGURE}>
                  Billed
                </th>
                {showList && (
                  <th scope="col" className={FIGURE}>
                    At list price
                  </th>
                )}
                <th scope="col" className={FIGURE}>
                  Share
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={`${row.key ?? ''}|${row.key2 ?? ''}`}>
                  <td className="break-words">
                    {dimension ? (
                      <button
                        type="button"
                        className="ficus-button ficus-button-ghost -ml-1.5 px-1.5 py-0.5 text-left"
                        title={`Show only ${row.label}`}
                        onClick={() => onFilter(dimension, row.key)}
                      >
                        {row.label}
                      </button>
                    ) : (
                      row.label
                    )}
                    <span className="block text-xs text-muted sm:hidden">
                      {`${countLabel(row.calls, 'call', 'calls')} · ${formatTokens(row.tokens)} tokens`}
                    </span>
                  </td>
                  {second && (
                    <td className="break-words">
                      <button
                        type="button"
                        className="ficus-button ficus-button-ghost -ml-1.5 px-1.5 py-0.5 text-left"
                        title={`Show only ${row.label2}`}
                        onClick={() => onFilter(second, row.key2 ?? null)}
                      >
                        {row.label2}
                      </button>
                    </td>
                  )}
                  <td className={`${FIGURE} ${WIDE_ONLY}`}>{row.calls.toLocaleString('en-US')}</td>
                  <td className={`${FIGURE} ${WIDE_ONLY}`}>{formatTokens(row.tokens)}</td>
                  <td className={FIGURE}>{formatSpend(row.billedUsd, row.approximate)}</td>
                  {showList && <td className={`${FIGURE} text-muted`}>{formatUsd(row.listUsd)}</td>}
                  <td className={`${FIGURE} text-muted`}>
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
