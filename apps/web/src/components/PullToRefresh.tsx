import { useCallback, useEffect, useRef, useState, type HTMLAttributes, type ReactNode } from 'react'
import clsx from 'clsx'
import { useStableRef } from '../hooks/useStableRef'
import { SpinnerIcon } from './icons'

const PULL_THRESHOLD_PX = 72
const MAX_PULL_DISTANCE_PX = 96

interface PullToRefreshProps extends HTMLAttributes<HTMLDivElement> {
  onRefresh: () => Promise<void> | void
  label: string
  children: ReactNode
}

function getTouchOrigin(event: TouchEvent, fallback: HTMLElement): HTMLElement {
  return event.target instanceof HTMLElement ? event.target : fallback
}

function getScrollContainer(element: HTMLElement): HTMLElement {
  let current: HTMLElement | null = element

  while (current && current !== document.body && current !== document.documentElement) {
    let overflowY = current.style.overflowY
    try {
      overflowY = window.getComputedStyle(current).overflowY || overflowY
    } catch {
      // Non-browser renderers can fail computed style lookups; inline style is enough as a fallback.
    }
    const canScroll = /(auto|scroll|overlay)/.test(overflowY)
    if (canScroll && current.scrollHeight > current.clientHeight) return current
    current = current.parentElement
  }

  return element
}

export function PullToRefresh({ onRefresh, label, children, className, style, ...props }: PullToRefreshProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const touchStartYRef = useRef<number | null>(null)
  const pullDistanceRef = useRef(0)
  const isRefreshingRef = useRef(false)
  const onRefreshRef = useStableRef(onRefresh)
  const [pullDistance, setPullDistance] = useState(0)
  const [isRefreshing, setIsRefreshing] = useState(false)

  const resetPull = useCallback(() => {
    touchStartYRef.current = null
    pullDistanceRef.current = 0
    setPullDistance(0)
  }, [])

  const refresh = useCallback(async () => {
    isRefreshingRef.current = true
    setIsRefreshing(true)
    try {
      await onRefreshRef.current()
    } finally {
      isRefreshingRef.current = false
      setIsRefreshing(false)
    }
  }, [onRefreshRef])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const handleTouchStart = (event: TouchEvent) => {
      if (isRefreshingRef.current || event.touches.length === 0) return

      const scrollContainer = getScrollContainer(getTouchOrigin(event, container))
      if (scrollContainer.scrollTop > 0) return

      touchStartYRef.current = event.touches[0].clientY
    }

    const handleTouchMove = (event: TouchEvent) => {
      if (touchStartYRef.current === null || event.touches.length === 0) return

      const scrollContainer = getScrollContainer(getTouchOrigin(event, container))
      if (scrollContainer.scrollTop > 0) {
        resetPull()
        return
      }

      const distance = event.touches[0].clientY - touchStartYRef.current
      if (distance <= 0) {
        pullDistanceRef.current = 0
        setPullDistance(0)
        return
      }

      event.preventDefault()
      const nextDistance = Math.min(distance, MAX_PULL_DISTANCE_PX)
      pullDistanceRef.current = nextDistance
      setPullDistance(nextDistance)
    }

    const handleTouchEnd = () => {
      const shouldRefresh = pullDistanceRef.current >= PULL_THRESHOLD_PX
      resetPull()

      if (shouldRefresh && !isRefreshingRef.current) {
        void refresh()
      }
    }

    container.addEventListener('touchstart', handleTouchStart, { passive: true })
    container.addEventListener('touchmove', handleTouchMove, { passive: false })
    container.addEventListener('touchcancel', handleTouchEnd)
    container.addEventListener('touchend', handleTouchEnd)

    return () => {
      container.removeEventListener('touchstart', handleTouchStart)
      container.removeEventListener('touchmove', handleTouchMove)
      container.removeEventListener('touchcancel', handleTouchEnd)
      container.removeEventListener('touchend', handleTouchEnd)
    }
  }, [refresh, resetPull])

  const hasIndicator = isRefreshing || pullDistance > 0
  const readyToRefresh = pullDistance >= PULL_THRESHOLD_PX
  const statusText = isRefreshing
    ? `Refreshing ${label}`
    : readyToRefresh
      ? 'Release to refresh'
      : `Pull to refresh ${label}`

  return (
    <div
      ref={containerRef}
      className={clsx('overscroll-contain touch-pan-y', className)}
      style={{ WebkitOverflowScrolling: 'touch', ...style }}
      {...props}
    >
      <div
        data-testid="pull-to-refresh-indicator"
        aria-live="polite"
        className={clsx(
          'mb-3 flex justify-center overflow-hidden text-sm text-secondary transition-all duration-200 sm:hidden',
          hasIndicator ? 'max-h-14 opacity-100' : 'max-h-0 opacity-0'
        )}
        style={{ transform: `translateY(${Math.max(0, pullDistance - PULL_THRESHOLD_PX) / 4}px)` }}
      >
        <div className="ficus-panel flex items-center gap-2 rounded-full bg-surface px-3 py-2">
          <span className="text-[rgb(var(--brand-gradient-to))]">
            <SpinnerIcon
              className={clsx('h-4 w-4', isRefreshing ? 'animate-spin' : readyToRefresh ? 'rotate-180' : '')}
            />
          </span>
          <span>{statusText}</span>
        </div>
      </div>
      {children}
    </div>
  )
}
