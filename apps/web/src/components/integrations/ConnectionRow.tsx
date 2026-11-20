import type { ReactNode } from 'react'
import clsx from 'clsx'
import { Badge } from '../Badge'
import { OverflowMenu } from '../OverflowMenu'
import type { ConnectionStatus } from './connectionStatus'

export interface ConnectionMenuItem {
  label: string
  onSelect: () => void
  disabled?: boolean
  /** Destructive items (Remove…) read in the danger colour. */
  danger?: boolean
}

export interface ConnectionInlineAction {
  label: string
  onClick: () => void
  disabled?: boolean
}

export interface ConnectionConfirmation {
  /** What happens, including how many squads lose access. */
  message: ReactNode
  /** The danger button's label, for example Remove or Disable. */
  confirmLabel: string
  onConfirm: () => void
  onCancel: () => void
  disabled?: boolean
}

/** The list that holds connection rows: one divider between rows and one under the last. */
export function ConnectionList({ children, className }: { children: ReactNode; className?: string }) {
  return <ul className={clsx('divide-y divide-panel-border border-b border-panel-border', className)}>{children}</ul>
}

/**
 * One pooled connection on a global integration card. The header reads as one flat row: the
 * connection's name and a quiet line about it, one status badge, at most one inline action (the one
 * that fixes that status, such as Reconnect or Enable) and a More actions menu for everything else.
 * Disable and Remove confirm in the row, under the header. Provider details (forms, notices, the
 * squads that use it) follow as children. Pass no inline action or menu items to a reader.
 */
export function ConnectionRow({
  title,
  leading,
  meta,
  status,
  inline,
  menu = [],
  confirmation,
  children,
}: {
  /** The connection's name, also the row's accessible name and the menu's. */
  title: string
  /** An optional icon before the name, such as a workspace's own icon. */
  leading?: ReactNode
  /** A quiet line (or lines) under the name: the account, kind or location. */
  meta?: ReactNode
  status: ConnectionStatus
  inline?: ConnectionInlineAction | null
  menu?: readonly (ConnectionMenuItem | false | null | undefined)[]
  confirmation?: ConnectionConfirmation | null
  children?: ReactNode
}) {
  const items = menu.filter((item): item is ConnectionMenuItem => !!item)
  return (
    <li className="py-4" aria-label={title}>
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
        <div className="flex min-w-0 items-start gap-2">
          {leading}
          <div className="min-w-0">
            <p className="font-medium text-primary">{title}</p>
            {meta && <div className="text-xs text-muted">{meta}</div>}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Badge color={status.color}>{status.label}</Badge>
          {inline && (
            <button
              className="ficus-button ficus-button-secondary rounded-md px-3 py-2 text-sm disabled:opacity-50"
              type="button"
              disabled={inline.disabled}
              onClick={inline.onClick}
            >
              {inline.label}
            </button>
          )}
          {items.length > 0 && (
            <OverflowMenu label={`More actions for ${title}`} itemsMarker="data-connection-actions">
              {items.map((item) => (
                <button
                  key={item.label}
                  type="button"
                  disabled={item.disabled}
                  className={item.danger ? 'text-status-danger-600 dark:text-status-danger-400' : undefined}
                  onClick={item.onSelect}
                >
                  {item.label}
                </button>
              ))}
            </OverflowMenu>
          )}
        </div>
      </div>
      {confirmation && (
        <div className="mt-3 flex flex-wrap items-center gap-2 rounded-lg bg-status-danger-surface px-3 py-2 text-sm text-status-danger-fg">
          {/* Below about 22rem the buttons wrap under the message instead of squeezing it. */}
          <div className="min-w-0 grow basis-56">{confirmation.message}</div>
          <button
            type="button"
            className="ficus-button ficus-button-danger rounded-md px-3 py-1.5 text-sm disabled:opacity-50"
            disabled={confirmation.disabled}
            onClick={confirmation.onConfirm}
          >
            {confirmation.confirmLabel}
          </button>
          <button
            type="button"
            className="ficus-button ficus-button-ghost rounded-md px-3 py-1.5 text-sm"
            onClick={confirmation.onCancel}
          >
            Cancel
          </button>
        </div>
      )}
      {children}
    </li>
  )
}
