import { isRoutineAssistantUpdate, type AssistantActivityUpdate } from '@ficus/shared'
import type { RenderItem } from '@ficus/client-core'

/** A transcript row routine updates can sit under, with the time it is shown at. */
export interface TimelineAnchor {
  id: string
  at: number
}

/** One coalesced chip: a task's routine updates in one timeline slot, oldest first. */
export interface RoutineUpdateGroup {
  taskId: string
  updates: AssistantActivityUpdate[]
}

/**
 * Rows of an Assistant transcript that render (inbox deliveries are hidden there), each timed by its
 * earliest merged row like the transcript's own timestamps.
 */
export function timelineAnchors(items: readonly RenderItem[]): TimelineAnchor[] {
  const anchors: TimelineAnchor[] = []
  for (const item of items) {
    if (item.kind !== 'persisted') continue
    if (item.message.role === 'human' && item.message.metadata?.source === 'inbox') continue
    const times = [item.message, ...(item.mergedFrom ?? [])]
      .map((message) => new Date(message.createdAt).getTime())
      .filter((time) => !Number.isNaN(time))
    if (times.length) anchors.push({ id: item.id, at: Math.min(...times) })
  }
  return anchors
}

/**
 * Place routine progress that no reply summarizes into the timeline: each update goes under the last
 * shown row at or before its time, and a task's updates in the same slot coalesce into one group.
 * Updates older than every loaded row belong to unloaded history and are left out.
 */
export function routineUpdateSlots(
  anchors: readonly TimelineAnchor[],
  updates: readonly AssistantActivityUpdate[]
): Map<string, RoutineUpdateGroup[]> {
  const ordered = [...anchors].sort((a, b) => a.at - b.at)
  const slots = new Map<string, RoutineUpdateGroup[]>()
  const routine = updates
    .filter((update) => !update.summarized && isRoutineAssistantUpdate(update))
    .sort((a, b) => a.sequence - b.sequence)
  for (const update of routine) {
    const at = new Date(update.createdAt).getTime()
    let anchor: TimelineAnchor | undefined
    for (const candidate of ordered) {
      if (candidate.at > at) break
      anchor = candidate
    }
    if (!anchor) continue
    const groups = slots.get(anchor.id) ?? []
    const group = groups.find((entry) => entry.taskId === update.taskId)
    if (group) group.updates.push(update)
    else groups.push({ taskId: update.taskId!, updates: [update] })
    slots.set(anchor.id, groups)
  }
  // Within a slot, a task's chip sits where its latest update would.
  for (const groups of slots.values())
    groups.sort((a, b) => a.updates[a.updates.length - 1]!.sequence - b.updates[b.updates.length - 1]!.sequence)
  return slots
}
