import { useCallback, useSyncExternalStore } from 'react'
import clsx from 'clsx'
import { WORK_STREAM_VIEW_CHANGED_EVENT, WORK_STREAM_VIEW_STORAGE_PREFIX } from '@ficus/shared/browser-keys'

export type WorkStreamViewMode = 'list' | 'kanban' | 'graph'
export type WorkStreamViewSurface = 'work' | 'home'

export function workStreamViewStorageKey(squadId: string, surface: WorkStreamViewSurface): string {
  return surface === 'work'
    ? `${WORK_STREAM_VIEW_STORAGE_PREFIX}${squadId}`
    : `${WORK_STREAM_VIEW_STORAGE_PREFIX}home.${squadId}`
}

function readView(
  squadId: string,
  surface: WorkStreamViewSurface,
  modes: readonly WorkStreamViewMode[]
): WorkStreamViewMode {
  if (typeof window === 'undefined') return 'list'
  try {
    const value = (window.localStorage.getItem(workStreamViewStorageKey(squadId, surface)) ??
      (surface === 'work'
        ? window.localStorage.getItem(`${WORK_STREAM_VIEW_STORAGE_PREFIX}work.${squadId}`)
        : null)) as WorkStreamViewMode | null
    return value && modes.includes(value) ? value : 'list'
  } catch {
    return 'list'
  }
}

export function useWorkStreamViewMode(
  squadId: string,
  surface: WorkStreamViewSurface,
  modes: readonly WorkStreamViewMode[]
): readonly [WorkStreamViewMode, (view: WorkStreamViewMode) => void] {
  const subscribe = useCallback(
    (notify: () => void) => {
      if (typeof window === 'undefined') return () => undefined
      const onStorage = (event: StorageEvent) => {
        if (event.key === workStreamViewStorageKey(squadId, surface)) notify()
      }
      const onLocalChange = (event: Event) => {
        if ((event as CustomEvent<string>).detail === `${surface}:${squadId}`) notify()
      }
      window.addEventListener('storage', onStorage)
      window.addEventListener(WORK_STREAM_VIEW_CHANGED_EVENT, onLocalChange)
      return () => {
        window.removeEventListener('storage', onStorage)
        window.removeEventListener(WORK_STREAM_VIEW_CHANGED_EVENT, onLocalChange)
      }
    },
    [squadId, surface]
  )

  const getSnapshot = useCallback(() => readView(squadId, surface, modes), [modes, squadId, surface])
  const view = useSyncExternalStore<WorkStreamViewMode>(subscribe, getSnapshot, () => 'list')
  const setView = useCallback(
    (next: WorkStreamViewMode) => {
      if (typeof window === 'undefined') return
      try {
        window.localStorage.setItem(workStreamViewStorageKey(squadId, surface), next)
      } catch {
        // Storage can be unavailable in private/locked-down browser contexts; the safe view remains List.
      }
      window.dispatchEvent(new window.CustomEvent(WORK_STREAM_VIEW_CHANGED_EVENT, { detail: `${surface}:${squadId}` }))
    },
    [squadId, surface]
  )
  return [view, setView]
}

export function WorkStreamViewToggle({
  squadId,
  surface,
  modes,
}: {
  squadId: string
  surface: WorkStreamViewSurface
  modes: readonly WorkStreamViewMode[]
}) {
  const [view, setView] = useWorkStreamViewMode(squadId, surface, modes)
  return (
    <div className="inline-flex overflow-hidden rounded-md border border-th-border" aria-label="Work stream view">
      {modes.map((option) => (
        <button
          key={option}
          type="button"
          aria-pressed={view === option}
          onClick={() => setView(option)}
          className={clsx(
            'ficus-button',
            'px-2.5 py-1.5 text-xs font-medium capitalize transition-colors',
            option !== modes[0] && 'border-l border-th-border',
            view === option ? 'bg-accent text-on-accent' : 'bg-surface text-secondary hover:bg-surface-hover'
          )}
        >
          {option}
        </button>
      ))}
    </div>
  )
}
