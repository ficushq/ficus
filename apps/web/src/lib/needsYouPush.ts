/**
 * Which OS notifications the in-app "Needs you" card replaces, shared by the service worker and the
 * page so both sides apply one rule.
 *
 * THE RULE: an OS notification is skipped only when a focused Ficus page confirms it is showing (or
 * already showed) the in-app card for that exact item. Anything the page does not confirm, for any
 * reason, still gets its OS notification, so a user may occasionally get neither card nor skip, but
 * never loses both.
 * - Ficus Desktop already shows no OS alert for an update while its window is focused, and the card
 *   only appears in a focused window.
 * - Browser web push (Chrome, Edge, Firefox): for a Needs-you push, the service worker asks its
 *   focused, visible Ficus windows whether they show a card for the push's `actionId`, waits up to
 *   `NEEDS_YOU_CONFIRM_TIMEOUT_MS`, and skips the OS notification only on a yes. Chrome exempts a
 *   focused origin from its show-a-notification rule, and Firefox does not charge its push quota
 *   while the site is open.
 * - WebKit (Safari, and every iOS browser): skipping the notification would get the push
 *   subscription revoked, so the OS notification always shows, and the page does not show the
 *   card when this browser is subscribed to push.
 */

/** The message a service worker sends a window to ask whether it shows a card for a push. */
export const NEEDS_YOU_PUSH_CHECK = 'ficus:needs-you-push-check'
/** How long the service worker waits for a window to confirm its card before showing the push. */
export const NEEDS_YOU_CONFIRM_TIMEOUT_MS = 2000

/** Push `actionId` prefixes for the pending-action types the in-app card can announce. */
const NEEDS_YOU_ACTION_PREFIXES = ['agent-question:', 'squad-question:', 'workstream-review:', 'workstream-blocked:']

/** The `actionId` of a push that may have an in-app card (a question or a gate), else null. */
export function needsYouPushActionId(data: unknown): string | null {
  const actionId = (data as { actionId?: unknown } | null | undefined)?.actionId
  return typeof actionId === 'string' && NEEDS_YOU_ACTION_PREFIXES.some((prefix) => actionId.startsWith(prefix))
    ? actionId
    : null
}

/**
 * WebKit revokes a push subscription whose push shows no notification, even while the site is
 * focused. Every iOS browser is WebKit (CriOS and FxiOS included); desktop Chromium and Firefox
 * are not.
 */
export function isWebKitEngine(userAgent: string): boolean {
  return /AppleWebKit\//.test(userAgent) && !/(Chrome|Chromium|Edg|OPR)\//.test(userAgent)
}

interface WindowClientFacts {
  focused: boolean
  visibilityState: DocumentVisibilityState
  url: string
}

/**
 * Service worker: the windows to ask about this push. Empty (show the notification) unless the push
 * may have a card, the engine allows skipping, and a Ficus window is focused and visible.
 * `isAppWindow` tells a Ficus window from a sibling app on the same origin (docs, deployed apps).
 */
export function needsYouPushWindows<T extends WindowClientFacts>(
  data: unknown,
  userAgent: string,
  windows: readonly T[],
  isAppWindow: (url: URL) => boolean
): T[] {
  if (!needsYouPushActionId(data) || isWebKitEngine(userAgent)) return []
  return windows.filter((client) => {
    if (!client.focused || client.visibilityState !== 'visible') return false
    try {
      return isAppWindow(new URL(client.url))
    } catch {
      return false
    }
  })
}

interface MessageTarget {
  postMessage(message: unknown, transfer: Transferable[]): void
}

/**
 * Service worker: ask each window whether it shows the card for `actionId`. Resolves true as soon
 * as one confirms; false when every window says no, or none answers in time (a window with no card
 * mounted, such as the voice workspace or sign-in, never answers).
 */
export function confirmNeedsYouCard(
  windows: readonly MessageTarget[],
  actionId: string,
  timeoutMs = NEEDS_YOU_CONFIRM_TIMEOUT_MS
): Promise<boolean> {
  if (windows.length === 0) return Promise.resolve(false)
  return new Promise((resolve) => {
    const channels: MessageChannel[] = []
    let pending = windows.length
    const finish = (shown: boolean) => {
      clearTimeout(timer)
      for (const channel of channels) channel.port1.close()
      resolve(shown)
    }
    const timer = setTimeout(() => finish(false), timeoutMs)
    for (const target of windows) {
      const channel = new MessageChannel()
      channels.push(channel)
      channel.port1.onmessage = (event: MessageEvent) => {
        if ((event.data as { shown?: unknown } | null)?.shown === true) finish(true)
        else if (--pending === 0) finish(false)
      }
      try {
        target.postMessage({ type: NEEDS_YOU_PUSH_CHECK, actionId }, [channel.port2])
      } catch {
        if (--pending === 0) finish(false)
      }
    }
  })
}

/**
 * Page: answer the service worker's questions. `handler` resolves whether this page shows (or
 * showed) the card for the action; any failure answers no, so the OS notification shows.
 */
export function subscribeNeedsYouPushChecks(handler: (actionId: string) => Promise<boolean>): () => void {
  const container = typeof navigator === 'undefined' ? undefined : navigator.serviceWorker
  if (!container) return () => {}
  const listener = (event: MessageEvent) => {
    const message = event.data as { type?: unknown; actionId?: unknown } | null
    const port = event.ports[0]
    if (message?.type !== NEEDS_YOU_PUSH_CHECK || typeof message.actionId !== 'string' || !port) return
    // Only this page's own service worker may ask. Anything else (or an uncontrolled page, whose
    // controller is null) gets no answer, so the asking worker times out and shows its notification.
    if (!event.source || event.source !== container.controller) return
    void handler(message.actionId)
      .catch(() => false)
      .then((shown) => port.postMessage({ shown }))
  }
  // Optional calls: navigator.serviceWorker may be partial or gone in teardown paths.
  container.addEventListener?.('message', listener)
  return () => container.removeEventListener?.('message', listener)
}
