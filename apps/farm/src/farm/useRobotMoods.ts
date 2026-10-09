import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { FARM_WATCHING_HEARTBEAT_MS, type FarmWatchingResponse } from '@ficus/shared'
import { client } from '../api/client'
import { isDemo } from '../app/demo'
import { useStableRef } from '../hooks/useStableRef'
import { moodStore, visibleRobotIds, type MoodSnapshot, type MoodStore } from './moods'
import type { FarmLayout } from './types'
import type { Camera } from './useCamera'

/** How long the view must stay put before a changed set of robots is reported (pans move every frame). */
export const VIEW_SETTLE_MS = 600

export type WatchingReporter = (agentIds: string[]) => Promise<FarmWatchingResponse>

/** The timers the hook uses (tests pass their own). */
export interface WatchingTimers {
  after: (ms: number, run: () => void) => () => void
  every: (ms: number, run: () => void) => () => void
}

const browserTimers: WatchingTimers = {
  after: (ms, run) => {
    const id = setTimeout(run, ms)
    return () => clearTimeout(id)
  },
  every: (ms, run) => {
    const id = setInterval(run, ms)
    return () => clearInterval(id)
  },
}

const reportToCore: WatchingReporter = (agentIds) =>
  client.transport.request<FarmWatchingResponse>('/farm/watching', { method: 'POST', body: { agentIds } })

/** The farm's moods, as the scene and cards draw them. */
export function useMoodSnapshot(store: MoodStore = moodStore): MoodSnapshot {
  return useSyncExternalStore(store.subscribe, store.get, store.get)
}

/**
 * Tells Core which robots are on screen: when the view settles on a different
 * set, and every 20s while this tab is visible (a hidden tab stops, so its
 * robots lapse 45s later). Core answers with whether moods are on and the
 * current moods; changes then arrive live.
 */
export function useRobotMoodWatching(
  layout: FarmLayout,
  camera: Camera,
  size: { width: number; height: number },
  options: { report?: WatchingReporter; store?: MoodStore; enabled?: boolean; timers?: WatchingTimers } = {}
) {
  const report = options.report ?? reportToCore
  const timers = options.timers ?? browserTimers
  const store = options.store ?? moodStore
  const enabled = options.enabled ?? !isDemo
  const ids = useMemo(() => visibleRobotIds(layout, camera, size), [layout, camera, size])
  const key = ids.join(',')
  const sendRef = useStableRef(() => {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
    report(ids)
      .then((response) => store.report(ids, response))
      // An older Core without moods, or offline: no moods, and the next heartbeat tries again.
      .catch(() => store.report(ids, { enabled: false, moods: {} }))
  })

  // A different set of robots on screen: report it once the view settles.
  useEffect(() => {
    if (!enabled || !size.width) return
    return timers.after(VIEW_SETTLE_MS, () => sendRef.current())
  }, [enabled, key, size.width, timers, sendRef])

  // The heartbeat, and a report straight away when the tab comes back.
  useEffect(() => {
    if (!enabled) return
    const stop = timers.every(FARM_WATCHING_HEARTBEAT_MS, () => sendRef.current())
    const onVisibility = () => {
      if (document.visibilityState === 'visible') sendRef.current()
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      stop()
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [enabled, timers, sendRef])
}
