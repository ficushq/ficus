import { useContext, useMemo } from 'react'
import clsx from 'clsx'
import type { FarmPerson } from '@ficus/shared'
import { agentLabel } from '../farm/agentLabels'
import { FarmCardContext, type FarmCardEnv } from '../farm/cards/context'
import type { Selection } from '../farm/selection'
import { tokenize, type FarmRef } from './messageTokens'

/** What a reference is called on this farm, and where on it it is (null: not on the farm). */
function resolve(ref: FarmRef, env: FarmCardEnv | null): { icon: string; label: string; goTo: Selection | null } {
  switch (ref.kind) {
    case 'ws': {
      const matches = (stream: { id: string; number?: number }) =>
        stream.id === ref.id || String(stream.number ?? '') === ref.id
      const plot = env?.layout.yards.flatMap((y) => y.plots).find((p) => matches(p.stream))
      const stream = plot?.stream ?? env?.input.streams.find(matches)
      return {
        icon: '🌱',
        label: stream?.title ?? (/^\d+$/.test(ref.id) ? `Work stream ${ref.id}` : 'A work stream'),
        goTo: plot ? { kind: 'plot', streamId: plot.stream.id } : null,
      }
    }
    case 'agent': {
      const agent = env?.agentsById.get(ref.id)
      return {
        icon: '🤖',
        label: agent ? agentLabel(agent).primary : 'A robot',
        goTo: agent ? { kind: 'robot', agentId: agent.id } : null,
      }
    }
    case 'squad': {
      const squad = env?.squadsById.get(ref.id)
      return {
        icon: '🏡',
        label: squad ? squad.name : 'A squad',
        goTo: squad ? { kind: 'yard', squadId: squad.id } : null,
      }
    }
  }
}

/**
 * A chat message's text: @mentions highlighted (yours more so), things on the
 * farm as chips that fly the camera to them, and other links clickable.
 */
export function MessageBody({
  body,
  people,
  meId,
}: {
  body: string
  people: readonly FarmPerson[]
  meId: string | null
}) {
  const env = useContext(FarmCardContext)
  const tokens = useMemo(() => tokenize(body, people), [body, people])
  return (
    <>
      {tokens.map((token, k) => {
        switch (token.kind) {
          case 'text':
            return token.text
          case 'mention':
            return (
              <span key={k} className={clsx('g-farmchat-mention', token.userId === meId && 'g-farmchat-mention-me')}>
                {token.text}
              </span>
            )
          case 'link':
            return (
              <a key={k} className="g-farmchat-link" href={token.href} target="_blank" rel="noopener noreferrer">
                {token.text}
              </a>
            )
          case 'ref': {
            const { icon, label, goTo } = resolve(token.ref, env)
            if (goTo && env)
              return (
                <button
                  key={k}
                  type="button"
                  className="g-farmchat-chip"
                  title={`Show ${label} on the farm`}
                  onClick={() => env.flyTo(goTo)}
                >
                  <span aria-hidden="true">{icon}</span> {label}
                </button>
              )
            // Not on this farm (finished, or elsewhere): a link to it if there is one, else just its name.
            return token.href ? (
              <a
                key={k}
                className="g-farmchat-chip g-farmchat-chip-away"
                href={token.href}
                target="_blank"
                rel="noopener noreferrer"
              >
                <span aria-hidden="true">{icon}</span> {label}
              </a>
            ) : (
              <span key={k} className="g-farmchat-chip g-farmchat-chip-away" title="Not on the farm right now">
                <span aria-hidden="true">{icon}</span> {label}
              </span>
            )
          }
        }
      })}
    </>
  )
}
