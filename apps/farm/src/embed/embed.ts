import { CSRF_HEADER } from '@ficus/shared/http-headers'
import {
  farmToAppMessage,
  parseAppToFarmMessage,
  parseFarmEmbedBootstrap,
  type AppToFarmMessage,
  type EmbedTheme,
  type FarmHaptic,
  type FarmToAppMessage,
} from '@ficus/shared/farm-embed'
import { apiUrl } from '../api/base'

/**
 * The farm inside a native app's web view (Ficus Mobile's Farm tab). The
 * message contract lives in @ficus/shared/farm-embed; this is the farm's end.
 * Outside a web view every function here is a no-op.
 */

interface NativeWebView {
  postMessage(message: string): void
}

declare global {
  interface Window {
    /** Set by react-native-webview inside the app. */
    ReactNativeWebView?: NativeWebView
    /** What the app injects before the farm loads (a handoff code, its theme). */
    __FICUS_EMBED__?: unknown
  }
}

export function isEmbedded(): boolean {
  return typeof window !== 'undefined' && typeof window.ReactNativeWebView?.postMessage === 'function'
}

export function postToApp(message: FarmToAppMessage): void {
  if (isEmbedded()) window.ReactNativeWebView!.postMessage(farmToAppMessage(message))
}

/** A light native tap for a moment worth feeling; the app decides how (and follows the system setting). */
export function haptic(kind: FarmHaptic): void {
  postToApp({ type: 'haptic', kind })
}

type Listener = (message: AppToFarmMessage) => void
const listeners = new Set<Listener>()
let listening = false

function receive(event: Event) {
  const message = parseAppToFarmMessage((event as MessageEvent).data)
  if (message) for (const listener of listeners) listener(message)
}

/** Messages from the app. react-native-webview dispatches on `window` (iOS) or `document` (Android). */
export function onAppMessage(listener: Listener): () => void {
  if (!listening && typeof window !== 'undefined') {
    window.addEventListener('message', receive)
    document.addEventListener('message', receive)
    listening = true
  }
  listeners.add(listener)
  return () => listeners.delete(listener)
}

// The app's theme, for the Futurist style (see skins/futurist/useFuturistTheme.ts).
let appTheme: EmbedTheme | null = null
const themeWatchers = new Set<() => void>()

export function embedTheme(): EmbedTheme | null {
  return appTheme
}

export function subscribeEmbedTheme(watch: () => void): () => void {
  themeWatchers.add(watch)
  return () => themeWatchers.delete(watch)
}

function setAppTheme(theme: EmbedTheme) {
  appTheme = theme
  for (const watch of themeWatchers) watch()
}

/**
 * Call once as the farm boots. In a web view it marks the page (for the
 * native-feel CSS), stops page zoom (the farm pinches its own camera), takes
 * what the app injected, and follows the app's theme. Returns the injected
 * handoff code to sign in with, if any.
 */
export function startEmbed(): { handoff: string | null } {
  if (!isEmbedded()) return { handoff: null }
  document.documentElement.dataset.embed = 'native'
  const viewport = document.querySelector<HTMLMetaElement>('meta[name="viewport"]')
  if (viewport && !viewport.content.includes('user-scalable')) {
    viewport.content = `${viewport.content}, maximum-scale=1, user-scalable=no`
  }
  const bootstrap = parseFarmEmbedBootstrap(window.__FICUS_EMBED__)
  // Don't leave a sign-in code lying around on the page.
  delete window.__FICUS_EMBED__
  if (bootstrap?.theme) setAppTheme(bootstrap.theme)
  onAppMessage((message) => {
    if (message.type === 'theme') setAppTheme(message.theme)
  })
  return { handoff: bootstrap?.handoff ?? null }
}

/** Trade a web handoff code for this web view's session cookie. True when signed in. */
export async function exchangeHandoff(code: string): Promise<boolean> {
  try {
    const response = await fetch(apiUrl('/auth/web-handoff/exchange'), {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', [CSRF_HEADER]: '1' },
      body: JSON.stringify({ code }),
    })
    return response.ok
  } catch {
    return false
  }
}

/** Tests only: forget listeners and the app theme. */
export function resetEmbedForTests(): void {
  listeners.clear()
  themeWatchers.clear()
  appTheme = null
  if (listening) {
    window.removeEventListener('message', receive)
    document.removeEventListener('message', receive)
    listening = false
  }
}
