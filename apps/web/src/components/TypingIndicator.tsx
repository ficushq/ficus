import { FicusLogo } from './FicusLogo'

/** The Ficus mark with its leaves dancing: shown while the agent is working. */
export function TypingIndicator({ label = 'Agent is working' }: { label?: string }) {
  return (
    <div className="flex items-center py-0.5" role="status" aria-label={label} data-testid="typing-indicator">
      <FicusLogo className="h-8 w-8" animated decorative />
    </div>
  )
}
