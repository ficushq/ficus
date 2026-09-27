import type { AssistantConversationActivity } from '@ficus/shared'
import { webAppUrl } from '../../api/base'
import { RobotAvatar } from '../RobotAvatar'
import { useFarmCard } from './context'

function ago(iso: string, now = Date.now()): string {
  const minutes = Math.max(0, Math.round((now - new Date(iso).getTime()) / 60_000))
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}

function news(c: AssistantConversationActivity): string | null {
  if (c.needsInputTasks) return c.needsInputTasks === 1 ? 'Needs your answer' : `${c.needsInputTasks} need your answer`
  if (c.unreadUpdates) return c.unreadUpdates === 1 ? '1 new update' : `${c.unreadUpdates} new updates`
  return null
}

/**
 * The porch assistant. Conversations are never deleted, so the porch shows one
 * robot, and this card offers a fresh conversation plus the few recent ones,
 * flagging any with updates or questions waiting.
 */
export function AssistantCard() {
  const env = useFarmCard()
  const agent = env.agentsById.get(env.input.assistants[0]?.id ?? '')
  const activity = env.input.assistantActivity
  const recent = activity?.conversations ?? []
  const totals = activity?.totals

  return (
    <>
      <div className="g-card-head">
        {agent && <RobotAvatar agent={agent} role="assistant" size={56} />}
        <div>
          <p className="g-eyebrow">Porch</p>
          <h2 className="g-card-title">Your assistant</h2>
        </div>
      </div>
      {totals && (totals.needsInputTasks > 0 || totals.unreadUpdates > 0) && (
        <p className="g-card-text g-delivery-note">
          {[
            totals.needsInputTasks > 0 && `${totals.needsInputTasks} waiting on your answer`,
            totals.unreadUpdates > 0 && `${totals.unreadUpdates} new update${totals.unreadUpdates === 1 ? '' : 's'}`,
          ]
            .filter(Boolean)
            .join(' · ')}
        </p>
      )}
      <button type="button" className="g-button g-button-primary g-card-wide" onClick={env.startAssistant}>
        Start a new conversation
      </button>
      <h3 className="g-card-subtitle">Recent</h3>
      {recent.length === 0 ? (
        <p className="g-card-text">{activity ? 'No conversations yet.' : 'Looking for your conversations…'}</p>
      ) : (
        <ul className="g-link-list">
          {recent.map((c) => {
            const note = news(c)
            return (
              <li key={c.id}>
                <button type="button" className="g-list-row" onClick={() => env.openAssistant(c.id)}>
                  <span className="g-list-title">{c.title || 'Untitled conversation'}</span>
                  <span className="g-crew-meta" data-needs={note ? 'yes' : undefined}>
                    {note ?? c.latestUpdate?.preview ?? 'No updates'} · {ago(c.latestUpdate?.createdAt ?? c.updatedAt)}
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      )}
      {activity?.hasMore && (
        <a className="g-link" href={webAppUrl('/')}>
          All conversations in Ficus
        </a>
      )}
    </>
  )
}
