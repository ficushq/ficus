import { useContext, useMemo, type ReactNode } from 'react'
import clsx from 'clsx'
import type { FarmPerson } from '@ficus/shared'
import { agentLabel } from '../farm/agentLabels'
import { FarmCardContext, type FarmCardEnv } from '../farm/cards/context'
import { SproutIcon } from '../icons'
import type { Selection } from '../farm/selection'
import { tokenize, type FarmRef } from './messageTokens'

/**
 * What a reference is called on this farm (`label`), what its chip shows
 * (`text`, when shorter than the label) and where on the farm it is (null:
 * not on the farm).
 */
function resolve(
  ref: FarmRef,
  env: FarmCardEnv | null
): { icon: ReactNode; label: string; text?: string; inline?: boolean; goTo: Selection | null } {
  switch (ref.kind) {
    case 'ws': {
      const matches = (stream: { id: string; number?: number }) =>
        stream.id === ref.id || String(stream.number ?? '') === ref.id
      const plot = env?.layout.yards.flatMap((y) => y.plots).find((p) => matches(p.stream))
      const stream = plot?.stream ?? env?.input.streams.find(matches)
      // Inline, like a link: a sprout and the number (a title makes it long and wrap; it's the tooltip instead).
      const number = stream?.number != null ? String(stream.number) : /^\d+$/.test(ref.id) ? ref.id : undefined
      return {
        icon: <SproutIcon className="g-farmchat-chip-sprout" />,
        label: stream?.title ?? (number ? `Work stream ${number}` : 'A work stream'),
        text: number ?? '',
        inline: true,
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
 * Something on the farm, as a chip with its name: clicking it selects it and
 * glides the camera there. Not on this farm, it's a plain chip, or a link to
 * `href` if there is one.
 */
export function FarmRefChip({ farmRef, href }: { farmRef: FarmRef; href?: string }) {
  const env = useContext(FarmCardContext)
  const { icon, label, text = label, inline, goTo } = resolve(farmRef, env)
  const kind = clsx('g-farmchat-chip', inline && 'g-farmchat-ref')
  // A short chip says what it is in full to screen readers.
  const named = text !== label ? { 'aria-label': label } : undefined
  const content = (
    <>
      <span aria-hidden="true">{icon}</span>
      {text && (
        <span className="g-farmchat-chip-text" aria-hidden={named ? true : undefined}>
          {text}
        </span>
      )}
    </>
  )
  if (goTo && env)
    return (
      <button
        type="button"
        className={kind}
        title={`Show ${label} on the farm`}
        {...named}
        onClick={() => env.flyTo(goTo)}
      >
        {content}
      </button>
    )
  return href ? (
    <a
      className={clsx(kind, 'g-farmchat-chip-away')}
      href={href}
      title={label}
      {...named}
      target="_blank"
      rel="noopener noreferrer"
    >
      {content}
    </a>
  ) : (
    <span
      className={clsx(kind, 'g-farmchat-chip-away')}
      title={`${label}: not on the farm right now`}
      role={named ? 'img' : undefined}
      {...named}
    >
      {content}
    </span>
  )
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
          case 'ref':
            return <FarmRefChip key={k} farmRef={token.ref} href={token.href} />
        }
      })}
    </>
  )
}
