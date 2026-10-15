import {
  type ReactNode,
  type TouchEvent,
  type WheelEvent,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'

/** A user scroll that leaves the box further than this above the bottom pauses following. */
const PAUSE_DISTANCE_PX = 30
/** Scrolling back down to within this distance of the bottom resumes following. */
const RESUME_DISTANCE_PX = 10

function distanceFromBottom(el: HTMLElement) {
  return el.scrollHeight - el.scrollTop - el.clientHeight
}

/**
 * Keeps a scrollable box pinned to its bottom while `follow` is on, for content
 * that streams in (tool output, tool-call arguments).
 *
 * The box is pinned after every commit (before paint) and on any DOM mutation
 * inside it, so fast bursts of appended text never leave new lines below the
 * fold. The user stays in control: scrolling up (wheel, touch drag, scrollbar
 * or keyboard) pauses following, and scrolling back down to the bottom, or
 * calling `resume` (the Follow button), picks it up again. Following is only a
 * streaming behaviour: when `follow` is off the box is never scrolled for the
 * user, so a finished call opened later behaves like any other box.
 */
function useFollowScroll<T extends HTMLElement>(follow: boolean) {
  const ref = useRef<T>(null)
  const [paused, setPausedState] = useState(false)
  const pausedRef = useRef(false)
  const followRef = useRef(follow)
  followRef.current = follow
  /** Last scrollTop seen, to tell whether a scroll event moved up or down. */
  const lastScrollTopRef = useRef(0)
  const touchYRef = useRef<number | null>(null)

  const setPaused = useCallback((value: boolean) => {
    if (pausedRef.current === value) return
    pausedRef.current = value
    setPausedState(value)
  }, [])

  const pin = useCallback(() => {
    const el = ref.current
    if (!el || !followRef.current || pausedRef.current) return
    el.scrollTop = el.scrollHeight
    lastScrollTopRef.current = el.scrollTop
  }, [])

  // Every commit (new streamed text, toggling follow, resuming) re-pins before paint.
  useLayoutEffect(pin)

  // Content can also change without this component committing (e.g. a child
  // updating its own state), so watch the subtree while following.
  useEffect(() => {
    const el = ref.current
    if (!follow || !el || typeof MutationObserver === 'undefined') return
    const observer = new MutationObserver(pin)
    observer.observe(el, { childList: true, subtree: true, characterData: true })
    return () => observer.disconnect()
  }, [follow, pin])

  // A finished stream forgets the pause, so the next one starts following.
  useEffect(() => {
    if (!follow) setPaused(false)
  }, [follow, setPaused])

  /** Pause right away on an upward gesture, so a busy stream cannot snap the box back under the user. */
  const pauseForUpwardGesture = useCallback(() => {
    const el = ref.current
    if (!el || !followRef.current) return
    if (el.scrollHeight > el.clientHeight && el.scrollTop > 0) setPaused(true)
  }, [setPaused])

  const onWheel = useCallback(
    (event: WheelEvent<T>) => {
      if (event.deltaY < 0) pauseForUpwardGesture()
    },
    [pauseForUpwardGesture]
  )

  const onTouchStart = useCallback((event: TouchEvent<T>) => {
    touchYRef.current = event.touches[0]?.clientY ?? null
  }, [])

  const onTouchMove = useCallback(
    (event: TouchEvent<T>) => {
      const y = event.touches[0]?.clientY
      if (y === undefined) return
      // A finger moving down drags the content down, i.e. scrolls up.
      if (touchYRef.current !== null && y > touchYRef.current) pauseForUpwardGesture()
      touchYRef.current = y
    },
    [pauseForUpwardGesture]
  )

  const onScroll = useCallback(() => {
    const el = ref.current
    if (!el) return
    const previousTop = lastScrollTopRef.current
    lastScrollTopRef.current = el.scrollTop
    if (!followRef.current) return
    const distance = distanceFromBottom(el)
    // Pinning only ever moves the box down, so moving up is the user (scrollbar, keyboard, ...).
    if (!pausedRef.current && el.scrollTop < previousTop && distance > PAUSE_DISTANCE_PX) {
      setPaused(true)
    } else if (pausedRef.current && el.scrollTop > previousTop && distance < RESUME_DISTANCE_PX) {
      setPaused(false)
    }
  }, [setPaused])

  const resume = useCallback(() => {
    pausedRef.current = false
    setPausedState(false)
    pin()
  }, [pin])

  return {
    ref,
    /** True while following is on but the user has scrolled away from the bottom. */
    paused: follow && paused,
    resume,
    handlers: { onScroll, onWheel, onTouchStart, onTouchMove },
  }
}

type FollowScrollBoxProps = {
  /** Element for the scroll box. */
  as?: 'div' | 'pre'
  /** Pin to the bottom as content arrives (the content is still streaming). */
  follow: boolean
  className?: string
  children: ReactNode
}

/** A scroll box that follows streaming content, with a Follow button while the user has scrolled away. */
export function FollowScrollBox({ as = 'div', follow, className, children }: FollowScrollBoxProps) {
  const { ref, paused, resume, handlers } = useFollowScroll<HTMLDivElement>(follow)
  // The handlers and ref only use HTMLElement members, so a <pre> can share the div typing.
  const Box = as as 'div'
  // Always keep the same wrapper so finishing the stream never remounts the box and loses its scroll position.
  return (
    <div className="relative">
      <Box ref={ref} className={className} data-follow-scroll="" {...handlers}>
        {children}
      </Box>
      {paused && (
        <button
          type="button"
          onClick={resume}
          className="ficus-button ficus-button-primary absolute bottom-2 right-2 p-1 rounded text-[10px] shadow-sm"
          title="Resume auto-scroll"
        >
          ↓ Follow
        </button>
      )}
    </div>
  )
}

const ToolArgsFollowContext = createContext(false)

/** Set by the tool-args view while a call's arguments are still streaming in. */
export const ToolArgsFollowProvider = ToolArgsFollowContext.Provider

/** A scroll box inside a tool's ArgsView: follows the arguments while they are still streaming. */
export function ArgsScrollBox(props: Omit<FollowScrollBoxProps, 'follow'>) {
  return <FollowScrollBox {...props} follow={useContext(ToolArgsFollowContext)} />
}
