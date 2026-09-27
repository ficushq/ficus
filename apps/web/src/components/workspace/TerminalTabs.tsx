/**
 * TerminalTabs Component
 *
 * Tabbed interface for managing multiple terminal sessions.
 * Supports creating new sessions and reattaching to existing ones.
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import { useQuery } from '@tanstack/react-query'
import clsx from 'clsx'
import { Terminal } from './Terminal'
import { queries } from '../../queryOptions'
import { killTerminalSession } from '../../api/workspace'
import { DocumentSkeleton, SkeletonBlock } from '../loading/Skeleton'

export interface TerminalTabsProps {
  sandboxId: string
  selectedShell?: string | null
  onSelectShell?: (shell: string | null) => void
  disabled?: boolean
}

interface Tab {
  id: string // Temporary ID for new tabs, becomes sessionId after creation
  sessionId?: string // Set after session is created on the server
  label: string
}

export function TerminalTabs({ sandboxId, selectedShell, onSelectShell, disabled = false }: TerminalTabsProps) {
  const [tabs, setTabs] = useState<Tab[]>([])
  const [initialized, setInitialized] = useState(false)
  const tabCounterRef = useRef(0)
  // Track pending active tab for new tabs that don't have a sessionId yet
  const [pendingActiveTabId, setPendingActiveTabId] = useState<string | null>(null)

  // Compute active tab: pending tab (for new tabs) > URL shell > first tab
  const activeTabId = (() => {
    // If we have a pending tab (new tab without session yet), use that
    if (pendingActiveTabId) {
      const pendingTab = tabs.find((t) => t.id === pendingActiveTabId)
      if (pendingTab) return pendingTab.id
    }
    // Otherwise use URL shell param
    if (selectedShell) {
      const matchingTab = tabs.find((t) => t.sessionId === selectedShell)
      if (matchingTab) return matchingTab.id
    }
    // Fall back to first tab
    return tabs[0]?.id ?? null
  })()

  // Wrapper to set active tab - updates URL or sets pending
  const setActiveTabId = useCallback(
    (id: string | null) => {
      const tab = tabs.find((t) => t.id === id)
      if (tab?.sessionId) {
        // Tab has session, update URL
        setPendingActiveTabId(null)
        if (onSelectShell) {
          onSelectShell(tab.sessionId)
        }
      } else {
        // Tab doesn't have session yet, set as pending
        setPendingActiveTabId(id)
      }
    },
    [tabs, onSelectShell]
  )

  const nextTabLabel = useCallback(() => {
    tabCounterRef.current++
    return `Shell ${tabCounterRef.current}`
  }, [])

  // Fetch existing sessions on mount
  const { data: existingSessions, isLoading } = useQuery({
    ...queries.terminal.sessions(sandboxId),
    enabled: !!sandboxId,
    staleTime: 5000,
  })

  // Initialize tabs once when sessions query completes
  useEffect(() => {
    if (initialized || isLoading) return

    if (existingSessions && existingSessions.length > 0) {
      // Restore existing sessions
      const restoredTabs = existingSessions.map((session, index) => ({
        id: session.sessionId,
        sessionId: session.sessionId,
        label: `Shell ${index + 1}`,
      }))
      tabCounterRef.current = existingSessions.length
      setTabs(restoredTabs)
      // URL will determine active tab via selectedShell prop
    } else {
      // No existing sessions, create initial tab
      const initialTab: Tab = { id: crypto.randomUUID(), label: nextTabLabel() }
      setTabs([initialTab])
      // URL will be updated when session is created via handleSessionCreated
    }
    setInitialized(true)
  }, [existingSessions, isLoading, initialized, nextTabLabel])

  const handleAddTab = useCallback(() => {
    const newTab: Tab = { id: crypto.randomUUID(), label: nextTabLabel() }
    setTabs((prev) => [...prev, newTab])
    // Set pending active tab - URL will be updated when session is created
    setPendingActiveTabId(newTab.id)
  }, [nextTabLabel])

  const handleCloseTab = useCallback(
    (tabId: string) => {
      // Find the tab to get its sessionId before removing
      const tabToClose = tabs.find((t) => t.id === tabId)

      // Kill the backend session if it exists
      if (tabToClose?.sessionId) {
        killTerminalSession(tabToClose.sessionId).catch(() => {
          // Ignore errors - session may already be dead
        })
      }

      // Clear pending if we're closing the pending tab
      if (tabId === pendingActiveTabId) {
        setPendingActiveTabId(null)
      }

      // Compute next tabs and side effects outside setTabs (updater must be pure)
      const index = tabs.findIndex((t) => t.id === tabId)
      let nextTabs = tabs.filter((t) => t.id !== tabId)

      if (nextTabs.length === 0) {
        const newTab: Tab = { id: crypto.randomUUID(), label: nextTabLabel() }
        nextTabs = [newTab]
        setTabs(nextTabs)
        setPendingActiveTabId(newTab.id)
        return
      }

      setTabs(nextTabs)

      // If we closed the active tab, set pending to the adjacent tab immediately so
      // we don't flicker to tabs[0] while selectedShell (URL) still points at the closed session
      if (tabId === activeTabId) {
        const newIndex = Math.min(index, nextTabs.length - 1)
        const newActiveTab = nextTabs[newIndex]
        setPendingActiveTabId(newActiveTab.id)
        if (newActiveTab.sessionId) {
          onSelectShell?.(newActiveTab.sessionId)
        }
      }
    },
    [activeTabId, nextTabLabel, onSelectShell, pendingActiveTabId, tabs, sandboxId]
  )

  const handleSessionCreated = useCallback(
    (tabId: string, sessionId: string) => {
      setTabs((prev) => prev.map((tab) => (tab.id === tabId ? { ...tab, sessionId } : tab)))

      // If this tab was pending (new tab), clear pending and update URL
      if (tabId === pendingActiveTabId) {
        setPendingActiveTabId(null)
        if (onSelectShell) {
          setTimeout(() => onSelectShell(sessionId), 0)
        }
      }
      // Also update URL if this is the first tab and no shell in URL
      else if (onSelectShell && !selectedShell && !pendingActiveTabId) {
        setTimeout(() => onSelectShell(sessionId), 0)
      }
    },
    [onSelectShell, selectedShell, pendingActiveTabId]
  )

  const handleSessionExit = useCallback(() => {
    // Optionally auto-close the tab or show a message
    // For now, just leave it so the user can see the exit message
  }, [])

  // Don't render until initialized to prevent premature terminal connections
  if (!initialized) {
    return (
      <div className="flex h-full flex-col bg-[rgb(var(--term-bg))]">
        <div className="flex h-11 items-center border-b border-panel-border bg-surface px-3">
          <SkeletonBlock className="h-4 w-24 bg-[rgb(var(--term-loading-bg))]" />
        </div>
        <DocumentSkeleton label="Loading terminals" lines={8} className="flex-1 bg-[rgb(var(--term-bg))]" />
      </div>
    )
  }

  if (tabs.length === 0 && disabled) {
    return (
      <div className="h-full flex items-center justify-center bg-[rgb(var(--term-bg))] text-[rgb(var(--term-muted))]">
        Task completed — terminal sessions closed
      </div>
    )
  }

  if (tabs.length === 0) {
    return (
      <div className="flex h-full flex-col bg-[rgb(var(--term-bg))]">
        <div className="flex h-11 items-center border-b border-panel-border bg-surface px-3">
          <SkeletonBlock className="h-4 w-24 bg-[rgb(var(--term-loading-bg))]" />
        </div>
        <DocumentSkeleton label="Loading terminals" lines={8} className="flex-1 bg-[rgb(var(--term-bg))]" />
      </div>
    )
  }

  return (
    <div className="h-full flex flex-col bg-[rgb(var(--term-bg))]">
      {/* Tab bar */}
      <div className="flex min-h-11 items-center gap-1 px-2 py-1 bg-surface shrink-0">
        <div className="flex-1 flex items-center overflow-x-auto">
          {tabs.map((tab) => (
            <div
              key={tab.id}
              className={clsx(
                'group flex items-center gap-2 rounded-lg px-3 py-1.5 text-xs cursor-pointer',
                tab.id === activeTabId
                  ? 'bg-selection text-accent-light'
                  : 'text-muted hover:text-primary hover:bg-surface-hover'
              )}
              onClick={() => setActiveTabId(tab.id)}
            >
              <span>{tab.label}</span>
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  handleCloseTab(tab.id)
                }}
                className="ficus-button w-4 h-4 flex items-center justify-center rounded hover:bg-surface-hover text-muted hover:text-primary"
                title="Close"
              >
                ×
              </button>
            </div>
          ))}
        </div>
        {!disabled && (
          <button
            onClick={handleAddTab}
            className="ficus-button px-3 py-2 text-muted hover:text-primary hover:bg-surface-hover"
            title="New terminal"
          >
            +
          </button>
        )}
      </div>

      {/* Terminal content */}
      <div className="flex-1 relative">
        {tabs.map((tab) => (
          <div key={tab.id} className={clsx('absolute inset-0', tab.id !== activeTabId && 'invisible')}>
            <Terminal
              sandboxId={sandboxId}
              sessionId={tab.sessionId}
              isActive={tab.id === activeTabId}
              onSessionCreated={(sessionId) => handleSessionCreated(tab.id, sessionId)}
              onSessionExit={handleSessionExit}
            />
          </div>
        ))}
      </div>
    </div>
  )
}
