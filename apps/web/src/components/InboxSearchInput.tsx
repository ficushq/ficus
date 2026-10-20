import clsx from 'clsx'
import { INBOX_SEARCH_MAX_LENGTH } from '@ficus/shared'
import { SearchIcon } from './icons'

interface InboxSearchInputProps {
  value: string
  onChange: (value: string) => void
  className?: string
  /** A pointer press on the field itself (the inbox popup pins a hover-opened sheet with it). */
  onPointerDown?: () => void
}

/** Search box for the inbox; results come from the server across the whole archive. */
export function InboxSearchInput({ value, onChange, className, onPointerDown }: InboxSearchInputProps) {
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
        maxLength={INBOX_SEARCH_MAX_LENGTH}
        onChange={(event) => onChange(event.target.value)}
        onPointerDown={onPointerDown}
        className="ficus-field w-full py-2 pl-9 pr-3 text-sm"
      />
    </div>
  )
}
