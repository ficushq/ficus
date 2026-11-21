/* eslint-disable react-refresh/only-export-components -- the button colocates its path helper */
import { useContext } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from 'react-router'
import clsx from 'clsx'
import { queries } from '../queryOptions'
import { useSquadSlugs } from '../hooks/useSquadSlugs'
import { FLOATING_WINDOW_CLICK_HINT } from '../lib/agentChatLinks'
import { agentChatPath } from '../lib/entityReference'
import { FloatingWindowAgentContext, useFloatingWindows, type FloatingWindowsApi } from './floatingWindowsContext'
import { useChatComposerOptionRow } from './chatComposerOptions'
import { ExpandIcon, PopOutIcon } from './icons'

/**
 * Where a floating window's chat goes when it leaves the window: its squad's Chats tab, or, for a
 * squadless agent (or one whose squad is not known yet), the Assistant's view of that agent.
 */
export function agentFullPagePath(agentId: string, squadSlug?: string): string {
  return agentChatPath({ id: agentId, squadId: squadSlug })
}

const BUTTON_CLASS = clsx(
  'ficus-button ficus-button-ghost',
  'rounded-md flex items-center justify-center transition-colors shrink-0 p-2.5 md:p-2 min-h-[44px] md:min-h-0'
)

/**
 * The composer control beside image, mic, auto-scroll, markdown and search: "Open in floating window"
 * for a chat on the page (or inside the assistant), "Open full page" inside that agent's floating
 * window. Nothing where floating windows are unavailable (narrow screens) or before the agent exists.
 * In a narrow composer's options menu it is a labelled row like the menu's others.
 */
export function FloatingChatButton({
  agentId,
  onPoppedOut,
}: {
  agentId: string | undefined
  /** After opening the window: the assistant steps back, so the chat is never shown in both places. */
  onPoppedOut?: () => void
}) {
  const windows = useFloatingWindows()
  const inWindow = useContext(FloatingWindowAgentContext)
  const row = useChatComposerOptionRow()
  if (!windows?.available || !agentId) return null
  if (inWindow === agentId) return <OpenFullPageButton agentId={agentId} windows={windows} />
  return (
    <button
      type="button"
      className={row ? row.rowClass : BUTTON_CLASS}
      aria-label="Open in floating window"
      title={`Open in floating window. ${FLOATING_WINDOW_CLICK_HINT}.`}
      onClick={() => {
        windows.open(agentId)
        onPoppedOut?.()
      }}
    >
      <PopOutIcon className={row ? clsx(row.iconClass, 'text-muted') : 'h-5 w-5'} />
      {row && 'Open in floating window'}
    </button>
  )
}

function OpenFullPageButton({ agentId, windows }: { agentId: string; windows: FloatingWindowsApi }) {
  const navigate = useNavigate()
  const { slugFor } = useSquadSlugs()
  const { data: agent } = useQuery(queries.agents.detail(agentId))
  const row = useChatComposerOptionRow()
  return (
    <button
      type="button"
      className={row ? row.rowClass : BUTTON_CLASS}
      aria-label="Open full page"
      title="Open full page (closes this window)"
      onClick={() => {
        navigate(agentFullPagePath(agentId, agent?.squadId ? slugFor(agent.squadId) : undefined))
        windows.dispatch({ type: 'close', agentId })
      }}
    >
      <ExpandIcon className={row ? clsx(row.iconClass, 'text-muted') : 'h-5 w-5'} />
      {row && 'Open full page'}
    </button>
  )
}
