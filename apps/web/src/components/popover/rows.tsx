import type { ReactNode } from 'react'
import { CheckIcon } from '../icons'

/** A row's icon, label, optional description (referenced by `descriptionId`) and selection check. */
export function PopoverRowContent({
  icon,
  label,
  description,
  descriptionId,
  checked,
}: {
  icon?: ReactNode
  label: string
  description?: string
  descriptionId?: string
  checked?: boolean
}) {
  return (
    <>
      {icon}
      <span className="min-w-0 flex-1 break-words">
        <span>{label}</span>
        {description && (
          <span id={descriptionId} className="mt-1 block text-xs font-normal text-secondary">
            {description}
          </span>
        )}
      </span>
      {checked && <CheckIcon className="h-4 w-4 shrink-0" aria-hidden="true" />}
    </>
  )
}

/** The small uppercase title some popovers show above their rows; hidden from assistive technology. */
export function PopoverHeading({ children }: { children: ReactNode }) {
  return (
    <p aria-hidden="true" className="ficus-section-title px-2 py-1.5">
      {children}
    </p>
  )
}
