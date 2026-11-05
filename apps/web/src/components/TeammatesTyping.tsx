import type { AgentChatTyper } from '../hooks/useAgentChatTyping'
import { useMediaQuery } from '../hooks/useMediaQuery'
import { MAX_TYPING_BUBBLES, typingSummary } from '../lib/teammatesTyping'

/**
 * Teammates typing in this chat: a chat bubble of three bouncing dots for each,
 * labeled with their name, at the end of the transcript where their message
 * will appear. Several typers stay compact: up to MAX_TYPING_BUBBLES bubbles,
 * the last one a "+N" for everyone else. Reduced motion keeps the dots still.
 */
export function TeammatesTyping({ typers }: { typers: AgentChatTyper[] }) {
  const reducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)', false)
  if (!typers.length) return null
  const shown = typers.length > MAX_TYPING_BUBBLES ? typers.slice(0, MAX_TYPING_BUBBLES - 1) : typers
  const more = typers.slice(shown.length)
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="teammates-typing"
      data-motion={reducedMotion ? 'reduced' : 'full'}
      className="flex flex-wrap items-end justify-end gap-x-3 gap-y-1.5"
    >
      <span className="sr-only">{typingSummary(typers.map((typer) => typer.name))}</span>
      {shown.map((typer) => (
        <div
          key={typer.userId}
          aria-hidden="true"
          data-testid="typing-bubble"
          className="flex min-w-0 flex-col items-end"
        >
          <span className="mb-0.5 mr-1 max-w-[10rem] truncate text-[11px] text-muted">{typer.name}</span>
          <TypingBubble>
            {[0, 1, 2].map((dot) => (
              <span
                key={dot}
                data-testid="typing-dot"
                className={
                  reducedMotion
                    ? 'h-1.5 w-1.5 rounded-full bg-current'
                    : 'ficus-typing-dot h-1.5 w-1.5 rounded-full bg-current'
                }
                style={reducedMotion ? undefined : { animationDelay: `${dot * 160}ms` }}
              />
            ))}
          </TypingBubble>
        </div>
      ))}
      {more.length > 0 && (
        <div aria-hidden="true" data-testid="typing-more" title={more.map((typer) => typer.name).join(', ')}>
          <TypingBubble>
            <span className="text-xs font-medium leading-none">+{more.length}</span>
          </TypingBubble>
        </div>
      )}
    </div>
  )
}

/** The rounded bubble itself, its tail corner toward the composer like a sent message. */
function TypingBubble({ children }: { children: React.ReactNode }) {
  return (
    <div className="inline-flex h-8 min-w-[3.25rem] items-center justify-center gap-1 rounded-2xl rounded-br-md bg-pill px-3 text-muted">
      {children}
    </div>
  )
}
