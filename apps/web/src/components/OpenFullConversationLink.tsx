import { Link } from 'react-router-dom'

/**
 * Opens an agent's full conversation in a new tab. A router Link, not a raw
 * `<a href="/squads/…">`, so the URL carries the base path the app is served
 * under (for example `/ficus`).
 */
export function OpenFullConversationLink({ squadSlug, agentId }: { squadSlug: string; agentId: string }) {
  return (
    <Link
      className="ficus-button ficus-button-ghost shrink-0 p-1.5 hover:text-accent-light"
      to={`/squads/${encodeURIComponent(squadSlug)}/agents?agent=${encodeURIComponent(agentId)}`}
      target="_blank"
      rel="noreferrer"
      title="Open full conversation"
      aria-label="Open full conversation"
    >
      ↗
    </Link>
  )
}
