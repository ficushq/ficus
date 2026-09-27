import { SparklesIcon } from './icons'
import { Presence } from './Presence'
import clsx from 'clsx'
import { useEffect, useState } from 'react'
import { Link, NavLink, useNavigate, useLocation } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { SettingsIcon, PencilIcon, InboxIcon, MoreIcon } from './icons'
import { TauLogo } from './TauLogo'
import { pendingActionsPresentation, usePendingActions } from '../hooks/usePendingActions'
import { desktopInstance } from '../lib/desktop'
import { queries } from '../queryOptions'
import { VoiceCompanionButton } from '../voice/VoiceCompanionWidget'
import { getTabNavigationTarget, recordTabPath } from '../hooks/useTabHistory'
import { usePermissions } from '../hooks/usePermissions'
import { useAssistantActivity } from '../hooks/useAssistantActivity'
import { AssistantActivityBadge } from './AssistantActivityBadge'
import { ThemeQuickPicker } from './ThemeQuickPicker'
import { useTheme } from '../providers/ThemeProvider'
import { selfServiceQueryEnabled, useOptionalAuth } from '../providers/AuthProvider'
import {
  isNavItemAllowed,
  moreMenuItems,
  navFooterHints,
  primaryMobileItems,
  resolveNavShortcut,
  visibleNavItems,
} from './navModel'
import { TOGGLE_ASSISTANT_EVENT } from '@ficus/shared/browser-keys'

type NavDependencies = {
  usePendingActions?: () => { data?: unknown[]; isError?: boolean; isLoading?: boolean; isFetching?: boolean }
  VoiceCompanionButton?: typeof VoiceCompanionButton
}

export function AppHeader({ usePendingActions: usePendingActionsProp = usePendingActions }: NavDependencies = {}) {
  const navigate = useNavigate()
  const location = useLocation()
  const isChat = location.pathname.startsWith('/chat')
  const [inboxPopupOpen, setInboxPopupOpen] = useState(false)
  const { can, isLoading: permissionsLoading } = usePermissions()
  const theme = useTheme()
  // Optional: AppHeader renders in some standalone/test contexts without
  // AuthProvider. No auth context (or no session, on an auth-required
  // instance) simply means no presets query — see selfServiceQueryEnabled,
  // which ThemePresetLibrary also uses so the two never drift apart.
  const auth = useOptionalAuth()
  const { data: themePresets } = useQuery({
    ...queries.themePresets.list(),
    enabled: selfServiceQueryEnabled(auth),
  })

  // Query for inbox unread count (desktop inbox icon badge): personal + shared system (if permitted)
  const canSystem = can('inbox:system')
  const { data: mineCount } = useQuery({ ...queries.inbox.mineCount(), refetchInterval: 10000 })
  const { data: systemCount } = useQuery({
    ...queries.inbox.systemCount(),
    refetchInterval: 10000,
    enabled: canSystem,
  })
  const unreadInboxCount = (mineCount?.count ?? 0) + (canSystem ? (systemCount?.count ?? 0) : 0)

  // Query for pending actions (desktop feed badge)
  const pendingPresentation = pendingActionsPresentation(usePendingActionsProp())
  const actionsError = pendingPresentation.status === 'error'
  const actionCount = pendingPresentation.count
  // Durable Assistant activity is discovered independently of whether the command bar is open.
  const assistantActivity = useAssistantActivity()
  // Only visible in the desktop inset (windowed) title bar (see .ficus-app-header-instance in
  // index.css); the label shows this window's Desktop instance name for every instance kind
  // (local, attached, or remote), disambiguating which instance this window is showing.
  const instance = desktopInstance()

  useEffect(() => {
    recordTabPath(location.pathname + location.search)
  }, [location.pathname, location.search])

  // Track inbox popup open state
  useEffect(() => {
    const handler = (e: Event) => {
      setInboxPopupOpen((e as CustomEvent).detail.isOpen)
    }
    window.addEventListener('inbox-popup-state', handler)
    return () => window.removeEventListener('inbox-popup-state', handler)
  }, [])

  // Handle keyboard shortcuts for navigation
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const tag = (e.target as HTMLElement).tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
      if ((e.target as HTMLElement).isContentEditable) return
      const to = resolveNavShortcut(e.key)
      if (to) navigate(to)
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [navigate])

  return (
    <>
      <header className="ficus-app-header ficus-glass relative border-b border-panel-border shrink-0 z-10 safe-area-pt safe-area-status-bar-scrim">
        <div className="ficus-app-header-bar max-w-7xl mx-auto py-2.5 md:py-3 px-4 md:px-6 flex items-center gap-4">
          {/* Left: Logo */}
          <h1 className="ficus-app-header-logo text-xl md:text-2xl font-bold text-primary">
            <Link to="/" className="flex items-center gap-2 hover:text-status-progress-600 transition-colors">
              <TauLogo />
              Ficus
              {instance && (
                <span
                  data-testid="desktop-instance-label"
                  className="ficus-app-header-instance ml-2 text-sm font-normal text-muted truncate max-w-[12rem]"
                >
                  {instance.name}
                </span>
              )}
            </Link>
          </h1>

          {/* Center: Desktop navigation */}
          <nav className="hidden md:flex gap-1 flex-1 justify-center">
            {visibleNavItems
              .filter(
                (item) =>
                  item.to !== '/settings' && item.to !== '/inbox' && isNavItemAllowed(item, can, permissionsLoading)
              )
              .map((item) => {
                // Feed should be active on both / and /feed
                const isActive =
                  item.to === '/'
                    ? location.pathname === '/' ||
                      location.pathname === '/feed' ||
                      location.pathname.startsWith('/actions')
                    : location.pathname.startsWith(item.to)
                const showActionBadge = item.to === '/' && (actionsError || (actionCount ?? 0) > 0)
                return (
                  <NavLink
                    key={item.to}
                    to={item.to}
                    className={clsx(
                      'ficus-nav-item relative px-4 py-2 rounded-md text-sm font-medium transition-colors',
                      isActive ? 'bg-selection text-accent-light' : 'text-secondary  hover:text-accent-light'
                    )}
                  >
                    {item.label}
                    {showActionBadge && (
                      <span
                        aria-label={actionsError ? 'Action Center unavailable' : undefined}
                        className="absolute -top-1 -right-1 bg-status-attention-500 text-status-attention-950 text-[10px] font-bold rounded-full min-w-[16px] h-4 flex items-center justify-center px-1"
                      >
                        {actionsError ? '!' : (actionCount ?? 0) > 99 ? '99+' : actionCount}
                      </span>
                    )}
                  </NavLink>
                )
              })}
          </nav>

          {/* Spacer on mobile (no center nav) */}
          <div className="flex-1 md:hidden" />

          {/* Right: Actions */}
          <div className="flex items-center gap-1">
            {/* Mobile new chat button - only on chat pages */}
            {isChat && (
              <button
                onClick={() => navigate('/chat?new')}
                className="ficus-button md:hidden p-2 text-accent-light hover:text-accent-light"
                title="New chat"
              >
                <PencilIcon className="w-5 h-5" />
              </button>
            )}

            <button
              onClick={() => window.dispatchEvent(new Event(TOGGLE_ASSISTANT_EVENT))}
              title="Assistant (⌘K / Ctrl+K)"
              aria-label="Assistant"
              aria-expanded={['open', 'expanded'].includes(new URLSearchParams(location.search).get('chat') ?? '')}
              className="ficus-button group relative flex items-center gap-1.5 p-2 text-muted hover:text-accent-light hover:bg-surface-hover"
            >
              <SparklesIcon className="w-5 h-5 motion-safe:transition-transform motion-safe:duration-150 motion-safe:group-hover:rotate-6 motion-safe:group-hover:scale-110" />
              <span className="hidden lg:inline text-xs">Assistant</span>
              <AssistantActivityBadge count={assistantActivity.unreadConversations} />
            </button>

            <NavLink
              to="/settings"
              className={({ isActive }) =>
                clsx(
                  'hidden md:flex items-center justify-center p-2 rounded-md',
                  isActive ? 'bg-selection text-accent-light' : 'text-muted hover:text-primary hover:bg-surface-hover'
                )
              }
              title="Settings (S)"
            >
              <SettingsIcon className="w-5 h-5" />
            </NavLink>

            <ThemeQuickPicker value={theme} presets={themePresets} />

            <button
              onClick={() => window.dispatchEvent(new Event('open-inbox-popup'))}
              className={clsx(
                'ficus-button',
                'relative hidden md:flex items-center justify-center p-2 rounded-md',
                inboxPopupOpen ? 'text-accent-light' : 'text-muted hover:text-primary hover:bg-surface-hover'
              )}
              title="Inbox (I)"
            >
              <InboxIcon className="w-5 h-5" />
              {unreadInboxCount > 0 && (
                <span className="absolute -top-0.5 -right-0.5 bg-status-danger-500 text-on-strong text-[10px] font-bold rounded-full min-w-[16px] h-4 flex items-center justify-center px-1">
                  {unreadInboxCount > 99 ? '99+' : unreadInboxCount}
                </span>
              )}
            </button>
          </div>
        </div>
      </header>
    </>
  )
}

export function MobileBottomNav({
  usePendingActions: usePendingActionsProp = usePendingActions,
}: Pick<NavDependencies, 'usePendingActions'> = {}) {
  const location = useLocation()
  const navigate = useNavigate()
  const pendingPresentation = pendingActionsPresentation(usePendingActionsProp())
  const actionsError = pendingPresentation.status === 'error'
  const actionCount = pendingPresentation.count
  const { can, isLoading: permissionsLoading } = usePermissions()
  const canSystem = can('inbox:system')
  const { data: mineCount } = useQuery({ ...queries.inbox.mineCount(), refetchInterval: 10000 })
  const { data: systemCount } = useQuery({
    ...queries.inbox.systemCount(),
    refetchInterval: 10000,
    enabled: canSystem,
  })
  const unreadInboxCount = (mineCount?.count ?? 0) + (canSystem ? (systemCount?.count ?? 0) : 0)
  const visibleMoreMenuItems = moreMenuItems.filter((item) => isNavItemAllowed(item, can, permissionsLoading))

  const dockItems = [...primaryMobileItems, ...(visibleMoreMenuItems.length === 1 ? visibleMoreMenuItems : [])]

  const [moreOpen, setMoreOpen] = useState(false)
  const isMoreActive = visibleMoreMenuItems.some((item) => location.pathname.startsWith(item.to))

  // Close menu on click outside
  useEffect(() => {
    if (!moreOpen) return
    function handleClick() {
      setMoreOpen(false)
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [moreOpen])

  // Close menu on navigation
  useEffect(() => {
    setMoreOpen(false)
  }, [location.pathname])

  return (
    <nav className="ficus-glass md:hidden shrink-0 border-t border-panel-border safe-area-pb z-10 [[data-keyboard=open]_&]:hidden">
      <div className="flex justify-around items-center h-16">
        {/* A lone secondary destination belongs directly in the dock. */}
        {dockItems.map((item) => {
          // Feed should be active on both / and /feed
          const isActive =
            item.to === '/'
              ? location.pathname === '/' || location.pathname === '/feed' || location.pathname.startsWith('/actions')
              : location.pathname.startsWith(item.to)
          const showActionBadge = item.to === '/' && (actionsError || (actionCount ?? 0) > 0)
          const showInboxBadge = item.to === '/inbox' && unreadInboxCount > 0
          const badgeCount = showActionBadge
            ? actionsError
              ? '!'
              : actionCount
            : showInboxBadge
              ? unreadInboxCount
              : 0

          return (
            <a
              key={item.to}
              href={item.to}
              aria-current={isActive ? 'page' : undefined}
              data-active={isActive}
              onClick={(e) => {
                e.preventDefault()
                navigate(getTabNavigationTarget(location.pathname + location.search, item.to))
              }}
              className={clsx(
                'ficus-dock-item flex flex-col items-center justify-center flex-1 h-full min-w-0',
                isActive ? 'text-accent-light' : 'text-muted hover:text-primary'
              )}
            >
              {item.icon}
              {badgeCount !== 0 && (
                <span
                  aria-label={showActionBadge && actionsError ? 'Action Center unavailable' : undefined}
                  className={clsx(
                    'absolute top-1.5 left-1/2 translate-x-1/2 text-[10px] font-bold rounded-full min-w-[1rem] h-4 flex items-center justify-center px-1',
                    showActionBadge
                      ? 'bg-status-attention-500 text-status-attention-950'
                      : 'bg-status-danger-500 text-on-strong'
                  )}
                >
                  {typeof badgeCount === 'number' && badgeCount > 99 ? '99+' : badgeCount}
                </span>
              )}
              <span className="text-xs mt-1">{item.label}</span>
            </a>
          )
        })}

        {visibleMoreMenuItems.length > 1 && (
          <div className="relative flex-1 h-full min-w-0">
            <button
              aria-expanded={moreOpen}
              data-active={isMoreActive || moreOpen}
              onClick={(e) => {
                e.stopPropagation()
                setMoreOpen((v) => !v)
              }}
              className={clsx(
                'ficus-button ficus-dock-item',
                'flex flex-col items-center justify-center w-full h-full',
                isMoreActive || moreOpen ? 'text-accent-light' : 'text-muted hover:text-primary'
              )}
            >
              <MoreIcon />
              <span className="text-xs mt-1">More</span>
            </button>

            <Presence
              open={moreOpen}
              className="ficus-overlay absolute bottom-full right-0 mb-2 mr-2 bg-surface rounded-lg shadow-theme-lg border border-th-border py-1 min-w-[160px]"
              onMouseDown={(e) => e.stopPropagation()}
            >
              {visibleMoreMenuItems.map((item) => {
                const isActive = location.pathname.startsWith(item.to)
                return (
                  <button
                    key={item.to}
                    onClick={() => navigate(getTabNavigationTarget(location.pathname + location.search, item.to))}
                    className={clsx(
                      'ficus-button',
                      'flex items-center gap-3 w-full px-4 py-3 text-sm',
                      isActive
                        ? 'text-accent-light bg-status-progress-50 dark:bg-status-progress-900/20'
                        : 'text-primary hover:bg-surface-hover'
                    )}
                  >
                    {item.icon}
                    {item.label}
                  </button>
                )
              })}
            </Presence>
          </div>
        )}
      </div>
    </nav>
  )
}

export function DesktopFooter() {
  return (
    <footer className="hidden md:flex shrink-0 mt-auto mx-auto px-4 pt-6 pb-4 justify-center gap-4 text-xs text-muted">
      {navFooterHints().map((hint) => (
        <span key={hint.key}>
          <kbd className="px-1.5 py-0.5 bg-surface-secondary text-muted rounded text-[10px] font-mono">{hint.key}</kbd>{' '}
          {hint.label}
        </span>
      ))}
    </footer>
  )
}
