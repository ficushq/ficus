import type { PresenceFocus } from '@ficus/shared'
import { farmPersonInitials } from '@ficus/shared'
import { ChatBubblesIcon } from '../../icons'
import { useMultiplayer } from '../../multiplayer/MultiplayerProvider'
import { agentLabel } from '../agentLabels'
import { findPlot } from '../find'
import type { Selection } from '../selection'
import { useFarmCard } from './context'

/** What someone's focus looks like in words: the thing they're at is named, and linked when it's on the farm. */
function describe(
  focus: PresenceFocus | null,
  env: ReturnType<typeof useFarmCard>
): { before: string; name?: string; after?: string; goTo: Selection | null } {
  if (!focus) return { before: 'Around the farm', goTo: null }
  switch (focus.kind) {
    case 'agent': {
      const agent = env.agentsById.get(focus.agentId)
      return agent
        ? { before: 'Talking to ', name: agentLabel(agent).primary, goTo: { kind: 'robot', agentId: focus.agentId } }
        : { before: 'Talking to a robot', goTo: null }
    }
    case 'workstream': {
      const plot = findPlot(env.layout, focus.workstreamId)
      return plot
        ? { before: 'At ', name: plot.stream.title, goTo: { kind: 'plot', streamId: focus.workstreamId } }
        : { before: 'At a plant', goTo: null }
    }
    case 'squad': {
      const squad = env.squadsById.get(focus.squadId)
      return squad
        ? { before: 'In the ', name: squad.name, after: ' yard', goTo: { kind: 'yard', squadId: focus.squadId } }
        : { before: 'In a yard', goTo: null }
    }
  }
}

/** Someone on the farm: what they're at (a link there), and ways to message or wave at them. */
export function PersonCard({ userId }: { userId: string }) {
  const env = useFarmCard()
  const { people, me, focus, wave, enabled, canChat } = useMultiplayer()
  const isMe = me?.userId === userId
  const person = people.find((p) => p.userId === userId)
  const name = isMe ? (me?.name ?? 'You') : (person?.name ?? 'Someone')
  const doing = describe(isMe ? focus : (person?.focus ?? null), env)
  return (
    <>
      <p className="g-eyebrow">{isMe ? 'You' : 'On the farm'}</p>
      <div className="g-person-card-head">
        <span className="g-person-initials" aria-hidden="true">
          {farmPersonInitials(name)}
        </span>
        <h2 className="g-card-title">{name}</h2>
      </div>
      <p className="g-card-text">
        {person || isMe ? (
          <>
            {doing.before}
            {doing.name &&
              (doing.goTo ? (
                <button
                  type="button"
                  className="g-inline-link"
                  title={`Show ${doing.name} on the farm`}
                  onClick={() => env.flyTo(doing.goTo!)}
                >
                  {doing.name}
                </button>
              ) : (
                doing.name
              ))}
            {doing.after}
          </>
        ) : (
          'Just left the farm'
        )}
      </p>
      <div className="g-card-actions">
        {!isMe && canChat && (
          <button
            type="button"
            className="g-button g-button-primary g-person-dm"
            title={`Open a private chat with ${name}`}
            onClick={() => env.messagePerson(userId)}
          >
            <ChatBubblesIcon />
            Message privately
          </button>
        )}
        {!isMe && person && enabled && canChat && (
          <button type="button" className="g-button" onClick={() => wave(userId)}>
            <span aria-hidden="true">👋</span> Wave
          </button>
        )}
        {isMe && (
          <button type="button" className="g-button g-button-primary" onClick={env.changeLook}>
            Change your look
          </button>
        )}
      </div>
    </>
  )
}
