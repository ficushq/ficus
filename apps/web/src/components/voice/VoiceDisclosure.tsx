import type { ReactNode } from 'react'
import { ChevronDownIcon } from '../icons'

/** Native disclosure semantics with the same chevron used by onboarding and voice pickers. */
export function VoiceDisclosure({
  summary,
  children,
  className = '',
}: {
  summary: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <details className={`rounded-lg border border-th-border p-3 [&[open]>summary>svg]:rotate-180 ${className}`}>
      <summary className="flex cursor-pointer list-none items-center justify-between gap-2 text-sm font-medium text-primary marker:hidden [&::-webkit-details-marker]:hidden">
        <span className="min-w-0">{summary}</span>
        <ChevronDownIcon className="h-4 w-4 shrink-0 text-muted transition-transform motion-reduce:transition-none" />
      </summary>
      {children}
    </details>
  )
}
