import { useState, useEffect, useCallback } from 'react'
import { useSearchParams } from 'react-router'
import { useStableRef } from './useStableRef'

interface UseFullscreenOptions {
  onEnter?: () => void
  onExit?: () => void
  /** Return false when a nested layer handled Escape and fullscreen must stay open. */
  shouldExitOnEscape?: () => boolean
  /** Sync fullscreen state to this URL search param (e.g. 'fullscreen').
   *  When set, state is driven by react-router search params.
   *  When omitted, state is local (useState). */
  queryParam?: string
}

export function useFullscreen(options: UseFullscreenOptions = {}) {
  const [searchParams, setSearchParams] = useSearchParams()
  const [localFullscreen, setLocalFullscreen] = useState(false)
  const onEnterRef = useStableRef(options.onEnter)
  const onExitRef = useStableRef(options.onExit)
  const shouldExitOnEscapeRef = useStableRef(options.shouldExitOnEscape)
  const queryParam = options.queryParam
  const isFullscreen = queryParam ? searchParams.has(queryParam) : localFullscreen

  const enterFullscreen = useCallback(() => {
    if (queryParam) {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev)
          next.set(queryParam, '1')
          return next
        },
        { replace: true }
      )
    } else {
      setLocalFullscreen(true)
    }
    onEnterRef.current?.()
  }, [onEnterRef, queryParam, setSearchParams])

  const exitFullscreen = useCallback(() => {
    if (queryParam) {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev)
          next.delete(queryParam)
          return next
        },
        { replace: true }
      )
    } else {
      setLocalFullscreen(false)
    }
    onExitRef.current?.()
  }, [onExitRef, queryParam, setSearchParams])

  const toggleFullscreen = useCallback(() => {
    if (isFullscreen) exitFullscreen()
    else enterFullscreen()
  }, [isFullscreen, enterFullscreen, exitFullscreen])

  useEffect(() => {
    if (!isFullscreen) return
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        if (shouldExitOnEscapeRef.current?.() ?? true) exitFullscreen()
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [isFullscreen, exitFullscreen, shouldExitOnEscapeRef])

  useEffect(() => {
    if (isFullscreen) {
      const originalOverflow = document.body.style.overflow
      document.body.style.overflow = 'hidden'
      return () => {
        document.body.style.overflow = originalOverflow
      }
    }
  }, [isFullscreen])

  return { isFullscreen, enterFullscreen, exitFullscreen, toggleFullscreen }
}
