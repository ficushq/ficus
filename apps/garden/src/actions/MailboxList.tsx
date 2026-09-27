import clsx from 'clsx'
import { useId, useState, type ReactNode } from 'react'
import type { PendingAction } from '@ficus/shared'
import { ActionView } from './ActionView'
import { ContinueAllButton } from './HaltedAgentAction'
import { actionSubtitle, actionTitle, groupActions, groupOf } from './present'

export interface MailboxListProps {
  actions: PendingAction[]
  onFocusStream?: (workStreamId: string) => void
  onOpenAssistant?: (conversationId: string, taskId?: string) => void
  onOpenAgent?: (agentId: string) => void
}

/**
 * Everything in the mailbox: pending actions grouped like the web Action
 * Center (halted robots, questions, assistant tasks, reviews, blocked), each
 * row expanding into its ActionView.
 */
export function MailboxList({ actions, onFocusStream, onOpenAssistant, onOpenAgent }: MailboxListProps) {
  if (actions.length === 0) {
    return (
      <div className="g-mailbox-empty" role="status">
        <p className="g-mailbox-empty-title">Nothing needs you. Enjoy the sunshine.</p>
        <p className="g-action-note">No pending questions, reviews or blocked work.</p>
      </div>
    )
  }
  // Like the web: a lone non-question action opens straight away.
  const onlyOne = actions.length === 1
  return (
    <div className="g-mailbox">
      {groupActions(actions).map((group) => (
        <MailboxSection key={group.id} title={group.title} subtitle={group.subtitle} count={group.actions.length}>
          {group.id === 'halted' && <ContinueAllButton actions={group.actions} />}
          <ul className="g-mail-list">
            {group.actions.map((action) => (
              <li key={action.id}>
                <MailboxItem
                  action={action}
                  defaultOpen={onlyOne && group.id !== 'questions'}
                  onFocusStream={onFocusStream}
                  onOpenAssistant={onOpenAssistant}
                  onOpenAgent={onOpenAgent}
                />
              </li>
            ))}
          </ul>
        </MailboxSection>
      ))}
    </div>
  )
}

function MailboxSection({
  title,
  subtitle,
  count,
  children,
}: {
  title: string
  subtitle: string
  count: number
  children: ReactNode
}) {
  const id = useId()
  return (
    <section className="g-mail-section" aria-labelledby={`${id}-title`}>
      <header className="g-mail-section-head">
        <h3 id={`${id}-title`} className="g-mail-section-title">
          {title} <span className="g-mail-count">{count}</span>
        </h3>
        <p className="g-action-note">{subtitle}</p>
      </header>
      {children}
    </section>
  )
}

function MailboxItem({
  action,
  defaultOpen,
  onFocusStream,
  onOpenAssistant,
  onOpenAgent,
}: {
  action: PendingAction
  defaultOpen: boolean
} & Omit<MailboxListProps, 'actions'>) {
  const [open, setOpen] = useState(defaultOpen)
  const bodyId = useId()
  return (
    <article className={clsx('g-mail-item', `g-mail-${groupOf(action)}`, open && 'g-mail-open')}>
      <button
        type="button"
        className="g-mail-toggle"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => setOpen(!open)}
      >
        <span className="g-mail-dot" aria-hidden="true" />
        <span className="g-mail-heading">
          <span className="g-mail-title">{actionTitle(action)}</span>
          <span className="g-mail-subtitle">{actionSubtitle(action)}</span>
        </span>
        <span className="g-mail-chevron" aria-hidden="true">
          {open ? '−' : '+'}
        </span>
      </button>
      {open && (
        <div id={bodyId} className="g-mail-body">
          <ActionView
            action={action}
            onFocusStream={onFocusStream}
            onOpenAssistant={onOpenAssistant}
            onOpenAgent={onOpenAgent}
          />
        </div>
      )}
    </article>
  )
}
