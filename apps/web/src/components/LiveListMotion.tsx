import { Component, type ReactNode } from 'react'
import {
  LIVE_EMPHASIS_ATTRIBUTE,
  LIVE_ROW_ATTRIBUTE,
  LIVE_STATUS_ATTRIBUTE,
  LIVE_MOVE_DURATION_MS,
  LIVE_MOVE_EASING,
  planLiveListMotion,
  sameLiveRows,
  type LiveRowAfter,
  type LiveRowBefore,
  type LiveRowIdentity,
} from '../lib/liveListMotion'
import './LiveListMotion.css'

export const LIVE_ARRIVED_CLASS = 'ficus-live-arrived'
export const LIVE_EMPHASIS_CLASS = 'ficus-live-emphasis'

interface LiveListMotionProps {
  /**
   * Everything that makes a change not live: the list's scope (squad), its filters, and its loading
   * or paging state. Any update in which it differs from the previous one animates nothing, so first
   * load, navigation within the same list, filter changes and loading more never move or flash rows.
   */
  resetKey: string
  children: ReactNode
}

type Snapshot = Map<string, LiveRowBefore> | null

/**
 * A frame that comes later than this after the update was held back (a hidden or throttled tab): the
 * change did not arrive while the list was on screen, so it does not animate.
 */
const STALE_FRAME_MS = 500

/**
 * Motion for changes that arrive while a list is on screen: rows slide to a new place in about
 * 300 ms (FLIP: measured just before the commit and again in the next animation frame, where the
 * browser lays the page out for that frame anyway, then animated on the compositor with a
 * transform), a row that arrived gets a brief wash, and a changed status badge a brief emphasis. Never on mount or when `resetKey` changes, never under reduced motion or in a hidden
 * tab, and only rows whose new place is on screen move.
 *
 * Rows are found by `liveRowProps` (lib/liveListMotion) anywhere inside, so one wrapper covers a
 * list's sections and a row moving between them. A class component, because only `getSnapshotBeforeUpdate` can read the
 * rows' places before React changes the DOM.
 */
export class LiveListMotion extends Component<LiveListMotionProps> {
  private container: HTMLDivElement | null = null
  private moves = new WeakMap<HTMLElement, Animation>()
  /** What the screen still shows while an update waits for its frame, and since when. */
  private pending: { before: Map<string, LiveRowBefore>; since: number } | null = null
  private frame: number | null = null

  private setContainer = (node: HTMLDivElement | null) => {
    this.container = node
  }

  getSnapshotBeforeUpdate(prevProps: LiveListMotionProps): Snapshot {
    if (prevProps.resetKey !== this.props.resetKey || !this.container || !motionAllowed()) {
      this.cancelFrame()
      return null
    }
    // Another update before the frame: nothing was painted in between, so the screen still shows
    // the places measured before the first one (kept by componentDidUpdate). No need to measure.
    if (this.pending) return this.pending.before
    const before = new Map<string, LiveRowBefore>()
    for (const row of liveRows(this.container)) {
      const key = row.getAttribute(LIVE_ROW_ATTRIBUTE)
      if (!key || before.has(key)) continue
      // Includes a move still in flight, so a row that moves again continues from where it is.
      const rect = row.getBoundingClientRect()
      before.set(key, { top: rect.top, left: rect.left, status: row.getAttribute(LIVE_STATUS_ATTRIBUTE) })
    }
    return before
  }

  componentDidUpdate(_prevProps: LiveListMotionProps, _prevState: unknown, before: Snapshot) {
    if (!before || !this.container) return
    this.pending ??= { before, since: performance.now() }
    if (this.frame !== null) return
    // Measuring here, inside React's commit, would force a layout the browser then repeats for the
    // frame after effects run. The next animation frame comes before that frame is painted.
    if (typeof requestAnimationFrame !== 'function') {
      this.playMotion()
      return
    }
    this.frame = requestAnimationFrame(() => {
      this.frame = null
      this.playMotion()
    })
  }

  componentWillUnmount() {
    this.cancelFrame()
  }

  private cancelFrame() {
    if (this.frame !== null) cancelAnimationFrame(this.frame)
    this.frame = null
    this.pending = null
  }

  private playMotion() {
    const pending = this.pending
    this.pending = null
    if (!pending || !this.container || !motionAllowed()) return
    if (performance.now() - pending.since > STALE_FRAME_MS) return
    const { before } = pending
    const elements = new Map<string, HTMLElement>()
    const identities: LiveRowIdentity[] = []
    for (const row of liveRows(this.container)) {
      const key = row.getAttribute(LIVE_ROW_ATTRIBUTE)
      if (!key || elements.has(key)) continue
      elements.set(key, row)
      identities.push({ key, status: row.getAttribute(LIVE_STATUS_ATTRIBUTE) })
    }
    // Most updates change nothing the rows show: skip measuring them.
    if (sameLiveRows(before, identities)) return

    // Writes, then one round of reads, then writes: stop moves in flight so each row measures at
    // its new layout place.
    for (const row of elements.values()) this.moves.get(row)?.cancel()
    const viewportHeight = window.innerHeight
    const after: LiveRowAfter[] = identities.map((identity) => {
      const rect = elements.get(identity.key)!.getBoundingClientRect()
      return {
        ...identity,
        top: rect.top,
        left: rect.left,
        visible: rect.height > 0 && rect.bottom > 0 && rect.top < viewportHeight,
      }
    })
    const plan = planLiveListMotion(before, after, { maxDistance: viewportHeight })

    for (const { key, dx, dy } of plan.moves) {
      const row = elements.get(key)!
      if (typeof row.animate !== 'function') continue
      const animation = row.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], {
        duration: LIVE_MOVE_DURATION_MS,
        easing: LIVE_MOVE_EASING,
      })
      this.moves.set(row, animation)
      animation.onfinish = () => {
        if (this.moves.get(row) === animation) this.moves.delete(row)
      }
    }
    for (const key of plan.arrivals) restartAnimationClass(elements.get(key)!, LIVE_ARRIVED_CLASS)
    for (const key of plan.statusChanges) {
      const badge = elements.get(key)!.querySelector<HTMLElement>(`[${LIVE_EMPHASIS_ATTRIBUTE}]`)
      if (badge) restartAnimationClass(badge, LIVE_EMPHASIS_CLASS)
    }
  }

  render() {
    return (
      <div ref={this.setContainer} className="contents" data-live-list="">
        {this.props.children}
      </div>
    )
  }
}

function liveRows(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(`[${LIVE_ROW_ATTRIBUTE}]`))
}

function motionAllowed(): boolean {
  if (typeof window === 'undefined' || typeof document === 'undefined') return false
  if (document.visibilityState === 'hidden') return false
  return !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
}

const listening = new WeakMap<HTMLElement, Set<string>>()

/**
 * Adds an animation class (restarting it if it is still running) and removes it when it ends. Each
 * class is named after its keyframes (see LiveListMotion.css).
 */
function restartAnimationClass(element: HTMLElement, className: string) {
  if (element.classList.contains(className)) {
    element.classList.remove(className)
    // Restart the animation: the browser must see the element without the class first.
    void element.offsetWidth
  }
  element.classList.add(className)
  const classes = listening.get(element) ?? new Set<string>()
  if (classes.has(className)) return
  classes.add(className)
  listening.set(element, classes)
  const onEnd = (event: AnimationEvent) => {
    // Animation events bubble: only this element's own animation (its ::after included) ends it.
    if (event.target !== element || event.animationName !== className) return
    element.classList.remove(className)
    element.removeEventListener('animationend', onEnd)
    classes.delete(className)
  }
  element.addEventListener('animationend', onEnd)
}
