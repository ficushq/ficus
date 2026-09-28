import type { PresenceFocus } from '@ficus/shared'
import { farmPersonInitials } from '@ficus/shared'
import { ChatBubblesIcon } from '../../icons'
import { useMultiplayer } from '../../multiplayer/MultiplayerProvider'
import { agentLabel } from '../agentLabels'
import { findPlot } from '../find'
import type { Selection } from '../selection'
import { useFarmCard } from './context'

/** What someone's focus looks like in words, and where "Go there" takes you. */
function describe(
  focus: PresenceFocus | null,
  env: ReturnType<typeof useFarmCard>
): { doing: string; goTo: Selection | null } {
  if (!focus) return { doing: 'Around the farm', goTo: null }
  switch (focus.kind) {
    case 'agent': {
      const agent = env.agentsById.get(focus.agentId)
      return {
        doing: agent ? `Talking to ${agentLabel(agent).primary}` : 'Talking to a robot',
        goTo: { kind: 'robot', agentId: focus.agentId },
      }
    }
    case 'workstream': {
      const plot = findPlot(env.layout, focus.workstreamId)
      return {
        doing: plot ? `At “${plot.stream.title}”` : 'At a plant',
        goTo: plot ? { kind: 'plot', streamId: focus.workstreamId } : null,
      }
    }
    case 'squad': {
      const squad = env.squadsById.get(focus.squadId)
      return {
        doing: squad ? `In the ${squad.name} yard` : 'In a yard',
        goTo: squad ? { kind: 'yard', squadId: focus.squadId } : null,
      }
    }
  }
}

/** Someone on the farm: what they're at, and a way to message them or go there. */
export function PersonCard({ userId }: { userId: string }) {
  const env = useFarmCard()
  const { people, me, focus, wave, enabled } = useMultiplayer()
  const isMe = me?.userId === userId
  const person = people.find((p) => p.userId === userId)
  const name = isMe ? (me?.name ?? 'You') : (person?.name ?? 'Someone')
  const { doing, goTo } = describe(isMe ? focus : (person?.focus ?? null), env)
  return (
    <>
      <p className="g-eyebrow">{isMe ? 'You' : 'On the farm'}</p>
      <div className="g-person-card-head">
        <span className="g-person-initials" aria-hidden="true">
          {farmPersonInitials(name)}
        </span>
        <h2 className="g-card-title">{name}</h2>
      </div>
      <p className="g-card-text">{person || isMe ? doing : 'Just left the farm'}</p>
      <div className="g-card-actions">
        {!isMe && (
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
        {!isMe && person && enabled && (
          <button type="button" className="g-button" onClick={() => wave(userId)}>
            <span aria-hidden="true">👋</span> Wave
          </button>
        )}
        {isMe && (
          <button type="button" className="g-button g-button-primary" onClick={env.changeLook}>
            Change your look
          </button>
        )}
        {goTo && (
          <button type="button" className="g-button" onClick={() => env.select(goTo)}>
            Go there
          </button>
        )}
      </div>
    </>
  )
}
