export interface DesktopNotification {
  id: string
  createdAt: string
  title: string
  body: string
  url: string
}
export interface DesktopNotificationBatch {
  userId: string
  notifications: DesktopNotification[]
}
export type DesktopUpdatePhase = 'idle' | 'checking' | 'downloading' | 'ready' | 'installing' | 'error'
export interface DesktopUpdateState {
  appVersion: string
  coreCommit: string
  supported: boolean
  phase: DesktopUpdatePhase
  availableVersion?: string
  progress?: { receivedBytes: number; totalBytes: number }
  lastCheckedAt?: string
  error?: string
}
export interface DesktopUpdates {
  state(): Promise<DesktopUpdateState>
  check(): Promise<DesktopUpdateState>
  install(): Promise<void>
  subscribe(listener: (state: DesktopUpdateState) => void): () => void
}
export interface DesktopShell {
  platform: 'darwin'
  insetTitleBar: boolean
  fullscreen(): Promise<boolean>
  onFullscreenChange(listener: (fullscreen: boolean) => void): () => void
}
export type DesktopInstanceKind = 'local' | 'attached' | 'remote'
export interface DesktopInstance {
  kind: DesktopInstanceKind
  name: string
  disconnect?(): Promise<void>
}
/**
 * The Ficus Desktop preload bridge. Members added after the first release are
 * optional: older and newer desktop builds keep `version: 1`, so feature-detect
 * each optional member rather than the version.
 */
export interface DesktopBridge {
  version: 1
  notificationsEnabled(): Promise<boolean>
  deliverNotifications(batch: DesktopNotificationBatch): Promise<void>
  setNotificationsEnabled?(enabled: boolean): Promise<boolean>
  updates?: DesktopUpdates
  shell?: DesktopShell
  instance?: DesktopInstance
  notificationsPolledByShell?: boolean
}
declare global {
  interface Window {
    /** Set by the Ficus Desktop preload. */
    ficusDesktopApp?: DesktopBridge
  }
}
export function desktopBridge(): DesktopBridge | undefined {
  if (typeof window === 'undefined') return undefined
  const bridge = window.ficusDesktopApp
  return bridge?.version === 1 ? bridge : undefined
}

function hasMethods<T extends object>(value: unknown, names: string[]): value is T {
  return (
    typeof value === 'object' &&
    value !== null &&
    names.every((name) => typeof (value as Record<string, unknown>)[name] === 'function')
  )
}

/** The desktop app's native update controls, when this desktop build provides them. */
export function desktopUpdates(): DesktopUpdates | undefined {
  const updates = desktopBridge()?.updates
  return hasMethods<DesktopUpdates>(updates, ['state', 'check', 'install', 'subscribe']) ? updates : undefined
}

/** The desktop window chrome integration, when this desktop build provides it. */
export function desktopShell(): DesktopShell | undefined {
  const shell = desktopBridge()?.shell
  return hasMethods<DesktopShell>(shell, ['fullscreen', 'onFullscreenChange']) ? shell : undefined
}

/** Whether this desktop build lets the web app change its notification preference. */
export function desktopNotificationToggle(): ((enabled: boolean) => Promise<boolean>) | undefined {
  const bridge = desktopBridge()
  return typeof bridge?.setNotificationsEnabled === 'function' ? bridge.setNotificationsEnabled.bind(bridge) : undefined
}

const DESKTOP_INSTANCE_KINDS = new Set<DesktopInstanceKind>(['local', 'attached', 'remote'])

/** Which Desktop instance this window shows, when this desktop build reports it. */
export function desktopInstance(): DesktopInstance | undefined {
  const instance = desktopBridge()?.instance
  if (
    !instance ||
    !DESKTOP_INSTANCE_KINDS.has(instance.kind) ||
    typeof instance.name !== 'string' ||
    !instance.name.trim()
  ) {
    return undefined
  }
  // Drop a malformed non-function `disconnect` from an untrusted/older bridge rather than
  // exposing it; otherwise keep the instance (and its optional disconnect) as reported.
  if (instance.disconnect !== undefined && typeof instance.disconnect !== 'function') {
    return { kind: instance.kind, name: instance.name }
  }
  return instance
}
