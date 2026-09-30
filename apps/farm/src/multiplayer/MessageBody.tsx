import { useContext, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import type { FarmPerson, WorkStream } from '@ficus/shared'
import { agentLabel } from '../farm/agentLabels'
import { FarmCardContext, type FarmCardEnv } from '../farm/cards/context'
import { SproutIcon } from '../icons'
import type { Selection } from '../farm/selection'
import type { PlotLayout } from '../farm/types'
import { StreamPreview } from './StreamPreview'
import { tokenize, type FarmRef } from './messageTokens'

interface Resolved {
  icon?: ReactNode
  /** What it's called on this farm. */
  label: string
  /** What it shows, when shorter than its label. */
  text?: string
  /** Where on the farm it is (null: not on the farm). */
  goTo: Selection | null
  /** A work stream's plant and stream, for its preview. */
  stream?: { plot?: PlotLayout; known?: WorkStream }
}

function resolve(ref: FarmRef, env: FarmCardEnv | null): Resolved {
  switch (ref.kind) {
    case 'ws': {
      const matches = (stream: { id: string; number?: number }) =>
        stream.id === ref.id || String(stream.number ?? '') === ref.id
      const plot = env?.layout.yards.flatMap((y) => y.plots).find((p) => matches(p.stream))
      const stream = plot?.stream ?? env?.input.streams.find(matches)
      // A sprout and the number: a title makes it long and wrap (hovering shows it, in a preview).
      const number = stream?.number != null ? String(stream.number) : /^\d+$/.test(ref.id) ? ref.id : undefined
      return {
        icon: <SproutIcon className="g-farmchat-chip-sprout" />,
        label: stream?.title ?? (number ? `Work stream ${number}` : 'A work stream'),
        text: number ?? '',
        goTo: plot ? { kind: 'plot', streamId: plot.stream.id } : null,
        stream: { plot, known: stream },
      }
    }
    case 'agent': {
      const agent = env?.agentsById.get(ref.id)
      return {
        label: agent ? agentLabel(agent).primary : 'A robot',
        goTo: agent ? { kind: 'robot', agentId: agent.id } : null,
      }
    }
    case 'squad': {
      const squad = env?.squadsById.get(ref.id)
      return {
        label: squad ? squad.name : 'A squad',
        goTo: squad ? { kind: 'yard', squadId: squad.id } : null,
      }
    }
  }
}

/** Hovering (after a moment) or focusing a work stream reference previews it. */
function usePreview(enabled: boolean) {
  const [open, setOpen] = useState(false)
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  const show = (delay: number) => {
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setOpen(true), delay)
  }
  const hide = () => {
    clearTimeout(timer.current)
    setOpen(false)
  }
  if (!enabled) return { open: false, anchor: null, close: hide, handlers: {} }
  return {
    open: open && !!anchor,
    anchor,
    close: hide,
    handlers: {
      ref: setAnchor,
      onPointerEnter: (e: React.PointerEvent) => e.pointerType === 'mouse' && show(250),
      onPointerLeave: hide,
      onFocus: () => show(0),
      onBlur: hide,
      onKeyDown: (e: React.KeyboardEvent) => {
        if (e.key === 'Escape' && open) {
          e.stopPropagation()
          hide()
        }
      },
    },
  }
}

/**
 * Something on the farm, inline in the text like a link (bold, underlined):
 * clicking it selects it and glides the camera there. Not on this farm, it's
 * plain (dimmed), or a link to `href` if there is one. A work stream, shown
 * only by its number, previews itself on hover or focus.
 */
export function FarmRefChip({ farmRef, href }: { farmRef: FarmRef; href?: string }) {
  const env = useContext(FarmCardContext)
  const { icon, label, text = label, goTo, stream } = resolve(farmRef, env)
  const kind = clsx('g-farmchat-chip', stream && 'g-farmchat-chip-stream')
  const previewId = useId()
  const preview = usePreview(!!stream && !!env)
  const previewHandlers = preview.handlers
  const described = preview.open ? { 'aria-describedby': previewId } : undefined
  const previewCard =
    preview.open && preview.anchor && env && stream ? (
      <StreamPreview
        id={previewId}
        anchor={preview.anchor}
        refId={farmRef.id}
        plot={stream.plot}
        known={stream.known}
        env={env}
      />
    ) : null
  // A short one says what it is in full to screen readers.
  const named = text !== label ? { 'aria-label': label } : undefined
  const content = (
    <>
      {icon && <span aria-hidden="true">{icon}</span>}
      {text && (
        <span className="g-farmchat-chip-text" aria-hidden={named ? true : undefined}>
          {text}
        </span>
      )}
    </>
  )
  // A previewed reference doesn't also need the browser's tooltip.
  const title = (fallback: string) => (stream ? undefined : fallback)
  if (goTo && env)
    return (
      <>
        <button
          type="button"
          className={kind}
          title={title(`Show ${label} on the farm`)}
          {...named}
          {...described}
          {...previewHandlers}
          onClick={() => {
            preview.close()
            env.flyTo(goTo)
          }}
        >
          {content}
        </button>
        {previewCard}
      </>
    )
  return href ? (
    <>
      <a
        className={clsx(kind, 'g-farmchat-chip-away')}
        href={href}
        title={title(label)}
        {...named}
        {...described}
        {...previewHandlers}
        onClick={preview.close}
        target="_blank"
        rel="noopener noreferrer"
      >
        {content}
      </a>
      {previewCard}
    </>
  ) : (
    <>
      <span
        className={clsx(kind, 'g-farmchat-chip-away')}
        title={title(`${label}: not on the farm right now`)}
        role={named ? 'img' : undefined}
        // Focusable, so a keyboard can preview it too.
        tabIndex={stream && env ? 0 : undefined}
        {...named}
        {...described}
        {...previewHandlers}
      >
        {content}
      </span>
      {previewCard}
    </>
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
