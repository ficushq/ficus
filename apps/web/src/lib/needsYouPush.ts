/**
 * Which OS notifications the in-app "Needs you" card replaces, shared by the service worker and the
 * page so both sides apply one rule.
 *
 * THE RULE: while a Ficus window is focused, the in-app card is the notice for a new question or
 * review, never an OS notification as well.
 * - Ficus Desktop already shows no OS alert for an update while its window is focused.
 * - Browser web push (Chrome, Edge, Firefox): the service worker skips the OS notification for a
 *   Needs-you push while one of its windows is focused. Those engines allow that: Chrome exempts a
 *   focused origin from its show-a-notification rule, and Firefox does not charge its push quota
 *   while the site is open.
 * - WebKit (Safari, and every iOS browser): skipping the notification would get the push
 *   subscription revoked, so the OS notification always shows, and the page does not show the
 *   card when this browser is subscribed to push.
 */

/** Push `actionId` prefixes for the pending-action types the in-app card announces. */
const NEEDS_YOU_ACTION_PREFIXES = ['agent-question:', 'squad-question:', 'workstream-review:', 'workstream-blocked:']

/** True when a push payload announces a question or a review/approval gate (a Needs-you item). */
export function isNeedsYouPush(data: unknown): boolean {
  const actionId = (data as { actionId?: unknown } | null | undefined)?.actionId
  return typeof actionId === 'string' && NEEDS_YOU_ACTION_PREFIXES.some((prefix) => actionId.startsWith(prefix))
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
 * Service worker: skip the OS notification because a focused Ficus window shows the in-app card.
 * `isAppWindow` tells a Ficus window from a sibling app on the same origin (docs, deployed apps).
 */
export function shouldSkipPushNotification(
  data: unknown,
  userAgent: string,
  windows: readonly WindowClientFacts[],
  isAppWindow: (url: URL) => boolean
): boolean {
  if (!isNeedsYouPush(data) || isWebKitEngine(userAgent)) return false
  return windows.some((client) => {
    if (!client.focused || client.visibilityState !== 'visible') return false
    try {
      return isAppWindow(new URL(client.url))
    } catch {
      return false
    }
  })
}
