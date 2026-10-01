import { useState } from 'react'
import { FicusLogo } from './FicusLogo'

/**
 * The Ficus mark with its leaves dancing: shown while the agent is working.
 * Click it and it does a little jump (mouse-only flair, so the button is out of
 * the tab order and hidden from assistive tech; the status label carries the
 * meaning). Each click restarts the jump by alternating two identical animations.
 */
export function TypingIndicator({ label = 'Agent is working' }: { label?: string }) {
  const [jumps, setJumps] = useState(0)
  return (
    <div className="flex items-center py-0.5" role="status" aria-label={label} data-testid="typing-indicator">
      <button
        type="button"
        tabIndex={-1}
        aria-hidden="true"
        className="ficus-plant-jump pointer-events-auto cursor-pointer border-0 bg-transparent p-0"
        data-jump={jumps === 0 ? undefined : jumps % 2 ? 'a' : 'b'}
        onClick={() => setJumps((count) => count + 1)}
      >
        <FicusLogo className="h-8 w-8" animated decorative />
      </button>
    </div>
  )
}
