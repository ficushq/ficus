import { useEffect, useRef } from 'react'
import { useStableRef } from '../hooks/useStableRef'

interface InboxLoadMoreProps {
  isFetching: boolean
  onLoadMore: () => void
}

/**
 * Infinite-scroll trigger for an inbox list: loads the next page as it scrolls into view, and stays
 * a plain button for keyboard users. Re-observing after each fetch loads again while it is still
 * visible, so a short page keeps filling until the list scrolls or is exhausted.
 */
export function InboxLoadMore({ isFetching, onLoadMore }: InboxLoadMoreProps) {
  const ref = useRef<HTMLButtonElement | null>(null)
  const onLoadMoreRef = useStableRef(onLoadMore)

  useEffect(() => {
    const node = ref.current
    if (!node || isFetching || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) onLoadMoreRef.current()
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [isFetching, onLoadMoreRef])

  return (
    <button
      ref={ref}
      type="button"
      onClick={() => onLoadMore()}
      disabled={isFetching}
      data-testid="inbox-load-more"
      className="ficus-button ficus-button-ghost w-full rounded-lg py-2 text-center text-xs text-muted focus-visible:-outline-offset-2"
    >
      {isFetching ? 'Loading more…' : 'Load more'}
    </button>
  )
}
