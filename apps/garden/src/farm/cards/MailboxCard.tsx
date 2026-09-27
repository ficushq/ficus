import { useFarmCard } from './context'
import { MailboxContents } from './slots'

export function MailboxCard() {
  const env = useFarmCard()
  const count = env.input.pendingActions.length
  return (
    <>
      <p className="g-eyebrow">Mailbox</p>
      <h2 className="g-card-title">{count ? `${count} need${count === 1 ? 's' : ''} you` : 'Nothing needs you'}</h2>
      <MailboxContents />
    </>
  )
}
