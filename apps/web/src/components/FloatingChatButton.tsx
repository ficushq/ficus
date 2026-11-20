/* eslint-disable react-refresh/only-export-components -- the button colocates its path helper */
import { useContext } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from 'react-router'
import clsx from 'clsx'
import { queries } from '../queryOptions'
import { useSquadSlugs } from '../hooks/useSquadSlugs'
import { FLOATING_WINDOW_CLICK_HINT } from '../lib/agentChatLinks'
import { FloatingWindowAgentContext, useFloatingWindows, type FloatingWindowsApi } from './floatingWindowsContext'
import { ExpandIcon, PopOutIcon } from './icons'

/** An agent's own chat page: its squad's agents panel, or the personal chat page. */
export function agentFullPagePath(agentId: string, squadSlug?: string): string {
  return squadSlug
    ? `/squads/${encodeURIComponent(squadSlug)}/agents?agent=${encodeURIComponent(agentId)}`
    : `/chat/${encodeURIComponent(agentId)}`
}

const BUTTON_CLASS = clsx(
  'ficus-button ficus-button-ghost',
  'rounded-md flex items-center justify-center transition-colors shrink-0 p-2.5 md:p-2 min-h-[44px] md:min-h-0'
)

/**
 * The composer control beside image, mic, auto-scroll, markdown and search: "Open in floating window"
 * for a chat on the page (or inside the assistant), "Open full page" inside that agent's floating
 * window. Nothing where floating windows are unavailable (narrow screens) or before the agent exists.
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
  if (!windows?.available || !agentId) return null
  if (inWindow === agentId) return <OpenFullPageButton agentId={agentId} windows={windows} />
  return (
    <button
      type="button"
      className={BUTTON_CLASS}
      aria-label="Open in floating window"
      title={`Open in floating window. ${FLOATING_WINDOW_CLICK_HINT}.`}
      onClick={() => {
        windows.open(agentId)
        onPoppedOut?.()
      }}
    >
      <PopOutIcon className="h-5 w-5" />
    </button>
  )
}

function OpenFullPageButton({ agentId, windows }: { agentId: string; windows: FloatingWindowsApi }) {
  const navigate = useNavigate()
  const { slugFor } = useSquadSlugs()
  const { data: agent } = useQuery(queries.agents.detail(agentId))
  return (
    <button
      type="button"
      className={BUTTON_CLASS}
      aria-label="Open full page"
      title="Open full page (closes this window)"
      onClick={() => {
        navigate(agentFullPagePath(agentId, agent?.squadId ? slugFor(agent.squadId) : undefined))
        windows.dispatch({ type: 'close', agentId })
      }}
    >
      <ExpandIcon className="h-5 w-5" />
    </button>
  )
}
