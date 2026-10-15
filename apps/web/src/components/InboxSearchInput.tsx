import clsx from 'clsx'
import { SearchIcon } from './icons'

interface InboxSearchInputProps {
  value: string
  onChange: (value: string) => void
  className?: string
}

/** Search box for the inbox; results come from the server across the whole archive. */
export function InboxSearchInput({ value, onChange, className }: InboxSearchInputProps) {
  return (
    <div className={clsx('relative', className)}>
      <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-muted">
        <SearchIcon className="h-4 w-4" />
      </span>
      <input
        type="search"
        aria-label="Search inbox"
        placeholder="Search all messages…"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="ficus-field w-full py-2 pl-9 pr-3 text-sm"
      />
    </div>
  )
}
