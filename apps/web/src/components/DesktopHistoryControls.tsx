import { useEffect, useSyncExternalStore } from 'react'
import { desktopBridge } from '../lib/desktop'
import { getDesktopHistory, NO_HISTORY } from '../lib/desktopHistory'

const subscribeNone = () => () => {}
const noHistory = () => NO_HISTORY

/** Desktop only, including fullscreen (which has no inset-titlebar attribute). */
export function DesktopHistoryControls() {
  const history = getDesktopHistory()
  const available = useSyncExternalStore(
    history?.subscribe ?? subscribeNone,
    history?.getSnapshot ?? noHistory,
    noHistory
  )
  const desktop = !!desktopBridge()
  useEffect(() => {
    if (!desktop || !history) return
    const onKeyDown = (event: KeyboardEvent) => {
      // Bubble on window, after React/editor and document handlers have consumed
      // their keys. Prevent Chromium's native default so it cannot navigate twice.
      if (
        event.defaultPrevented ||
        event.isComposing ||
        !event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        event.shiftKey
      )
        return
      if (event.key !== '[' && event.key !== ']') return
      event.preventDefault()
      if (!event.repeat) history.go(event.key === '[' ? -1 : 1)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [desktop, history])
  if (!desktop) return null
  return (
    <div className="flex items-center gap-0.5 shrink-0" role="group" aria-label="Navigation history">
      {([-1, 1] as const).map((direction) => (
        <button
          key={direction}
          type="button"
          aria-label={direction === -1 ? 'Go back' : 'Go forward'}
          title={direction === -1 ? 'Go back (⌘[)' : 'Go forward (⌘])'}
          disabled={direction === -1 ? !available.back : !available.forward}
          onClick={() => history?.go(direction)}
          className="ficus-button ficus-button-ghost p-1.5 rounded-md disabled:opacity-30 disabled:cursor-default focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
        >
          <svg
            aria-hidden="true"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="w-4 h-4"
          >
            <path d={direction === -1 ? 'M15 18l-6-6 6-6' : 'M9 6l6 6-6 6'} />
          </svg>
        </button>
      ))}
    </div>
  )
}
