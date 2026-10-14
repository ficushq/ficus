import type { StorageFolder } from '@ficus/shared'
import { ChevronRightIcon } from '../../icons'
import { measuredSize } from './format'

export function FolderRow({ folder }: { folder: StorageFolder }) {
  const label = (
    <span className="inline-flex w-full min-w-0 items-baseline justify-between gap-4">
      <span className="min-w-0 break-all" title={folder.path}>
        {folder.name}
      </span>
      <span className="shrink-0 tabular-nums text-secondary">{measuredSize(folder)}</span>
    </span>
  )
  if (!folder.children.length) return <div className="py-2 pl-5 text-sm">{label}</div>
  return (
    <details className="text-sm [&[open]>summary>svg]:rotate-90">
      <summary className="flex cursor-pointer list-none items-center gap-1 py-2 [&::-webkit-details-marker]:hidden">
        <ChevronRightIcon className="h-4 w-4 shrink-0 text-secondary" />
        {label}
      </summary>
      <div className="ml-4 border-l border-th-border pl-3">
        {folder.children.map((child) => (
          <FolderRow key={child.name} folder={child} />
        ))}
      </div>
    </details>
  )
}
