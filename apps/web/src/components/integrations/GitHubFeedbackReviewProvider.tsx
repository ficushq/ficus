/* eslint-disable react-refresh/only-export-components -- the provider and its hook are one unit. */
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react'
import type { GitHubFeedbackQueue } from '@ficus/shared'
import { GitHubFeedbackReviewModal } from './GitHubFeedbackReviewModal'

interface GitHubFeedbackReviewController {
  squadId: string
  open: (queue?: GitHubFeedbackQueue) => void
}

const ReviewContext = createContext<GitHubFeedbackReviewController | null>(null)

/**
 * One review modal per squad page. Home, Work and settings all open THIS instance, so selections
 * and the focused event survive switching surfaces, and there is never a second dialog.
 */
export function GitHubFeedbackReviewProvider({ squadId, children }: { squadId: string; children: ReactNode }) {
  const [state, setState] = useState<{ isOpen: boolean; queue: GitHubFeedbackQueue }>({
    isOpen: false,
    queue: 'pending',
  })
  // Focus returns to whichever Home/Work/settings control opened the dialog.
  const opener = useRef<HTMLElement | null>(null)
  const open = useCallback((queue: GitHubFeedbackQueue = 'pending') => {
    const active = document.activeElement
    opener.current = active && 'focus' in active ? (active as HTMLElement) : null
    setState({ isOpen: true, queue })
  }, [])
  const close = useCallback(() => {
    setState((current) => ({ ...current, isOpen: false }))
    if (opener.current?.isConnected) opener.current.focus()
    opener.current = null
  }, [])
  const value = useMemo(() => ({ squadId, open }), [squadId, open])
  return (
    <ReviewContext.Provider value={value}>
      {children}
      {/* Keyed by squad: a reviewed selection never carries over to another squad. */}
      <GitHubFeedbackReviewModal
        key={squadId}
        squadId={squadId}
        isOpen={state.isOpen}
        onClose={close}
        initialQueue={state.queue}
      />
    </ReviewContext.Provider>
  )
}

/** The page's shared review controller for this squad, or null outside a matching provider. */
export function useGitHubFeedbackReview(squadId: string): GitHubFeedbackReviewController | null {
  const controller = useContext(ReviewContext)
  return controller?.squadId === squadId ? controller : null
}
