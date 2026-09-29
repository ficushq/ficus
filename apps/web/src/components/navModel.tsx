import type { ReactElement } from 'react'
import {
  ActivityIcon,
  CalendarIcon,
  ChatIcon,
  SettingsIcon,
  SquadIcon,
  WorkStreamIcon,
  InboxIcon,
  LightningIcon,
} from './icons'

/**
 * The navigation model: one list that every nav surface reads.
 *
 * Historically the desktop nav, the keyboard shortcut handler and the footer key
 * hints each filtered this list independently, so hiding a destination meant
 * remembering all three. They now all consume `visibleNavItems` (or a helper
 * derived from it), which is what keeps them from drifting apart.
 *
 * Kept in its own module rather than in AppNav.tsx so the shared helpers don't
 * defeat react-refresh (a file should export only components or only values).
 */
export interface NavItem {
  to: string
  label: string
  /** Single-key navigation shortcut. Also what puts the item in the footer hints. */
  key?: string
  icon: ReactElement
  /**
   * Withheld from every nav surface — desktop nav, mobile nav, the keyboard
   * shortcut handler and the footer key hints — while the route itself stays
   * registered and reachable by URL. Delete this field to re-advertise the
   * destination; nothing else needs to change.
   */
  hidden?: boolean
}

export const navItems: NavItem[] = [
  { to: '/', label: 'Feed', key: 'f', icon: <WorkStreamIcon /> },
  { to: '/activity', label: 'Activity', key: 'a', icon: <ActivityIcon /> },
  { to: '/squads', label: 'Squads', key: 'q', icon: <SquadIcon /> },
  { to: '/chat', label: 'Chat', key: 'c', icon: <ChatIcon />, hidden: true },
  { to: '/inbox', label: 'Inbox', icon: <InboxIcon /> },
  { to: '/schedules', label: 'Schedules', icon: <CalendarIcon />, hidden: true },
  // Ops Insights lives in Settings now (?section=ops-insights); the route
  // stays registered as a redirect for old links. `hidden` withholds it from
  // every nav surface (see the field's doc above).
  { to: '/recommendations', label: 'Ops Insights', icon: <LightningIcon />, hidden: true },
  { to: '/settings', label: 'Settings', key: 's', icon: <SettingsIcon /> },
]

/**
 * The farm: its own app beside this one (apps/farm), served by Core at
 * `<APP_BASE_PATH>/farm/`, so a plain page link rather than a route here.
 */
export function farmHref(base: string = import.meta.env.BASE_URL || '/'): string {
  return `${base.replace(/\/?$/, '/')}farm/`
}

/** The single list every nav surface reads. */
export const visibleNavItems = navItems.filter((item) => !item.hidden)

// Mobile nav: primary items shown directly, secondary items in More menu.
export const primaryMobileItems = visibleNavItems.filter((i) =>
  ['/', '/activity', '/squads', '/chat', '/inbox'].includes(i.to)
)
export const moreMenuItems = visibleNavItems.filter((i) =>
  ['/schedules', '/recommendations', '/settings'].includes(i.to)
)

export function isNavItemAllowed(item: NavItem, can: (permission: string) => boolean, isLoading: boolean): boolean {
  if (item.to === '/recommendations') return !isLoading && can('recommendations:read')
  if (item.to === '/schedules') return !isLoading && can('schedules:read')
  return true
}

/**
 * Resolve a bare keypress to a nav destination, or undefined when that key is
 * not a shortcut. Hidden destinations resolve to undefined by construction: a
 * key that still navigated somewhere unadvertised would be worse than a visible
 * nav entry, because nothing on screen would explain where the user landed.
 */
export function resolveNavShortcut(key: string): string | undefined {
  return visibleNavItems.find((n) => n.key === key.toLowerCase())?.to
}

/** The footer key hints, in render order. */
export function navFooterHints(): { key: string; label: string }[] {
  return [
    ...visibleNavItems.filter((item) => item.key).map((item) => ({ key: item.key!.toUpperCase(), label: item.label })),
    // Not nav destinations: these toggle the inbox popup and the quick-chat
    // drawer in place. They are hardcoded because no navItem drives them — and
    // "Quick chat" is the drawer, not the /chat page, so it stays in the hints
    // even though Chat has left the nav.
    { key: 'I', label: 'Inbox' },
    { key: '⌘K / Ctrl K', label: 'Assistant' },
  ]
}

/**
 * Whether to render the header microphone. Voice needs both the `ai:voice`
 * permission and a server that actually has an OpenAI key — offering a mic that
 * fails on first use is the thing this gate exists to prevent.
 */
export function shouldShowVoiceButton(opts: {
  permissionsLoading: boolean
  canVoice: boolean
  voiceEnabled: boolean
}): boolean {
  return !opts.permissionsLoading && opts.canVoice && opts.voiceEnabled
}
