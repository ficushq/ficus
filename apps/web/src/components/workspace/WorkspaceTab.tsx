/**
 * WorkspaceTab Component
 *
 * Main workspace view combining file browser and terminal, for one target:
 * - the squad's shared workspace and squad box (the default), or
 * - one agent's private folder and its own sandbox (`?workspaceAgent=<id>`), for people
 *   with `agents:private-access` in the squad. The terminal there also needs
 *   `terminal:access` and starts in the private folder.
 *
 * Desktop layout:
 * - Top: FileTree (left) + FileViewer (right)
 * - Bottom: TerminalTabs (resizable)
 * Mobile layout:
 * - Tab switcher: Files | Terminal
 * - Files view: FileTree (full width, selecting a file shows FileViewer)
 */

import { useState, useCallback, useRef, useEffect, type ReactNode } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import clsx from 'clsx'
import { FileIcon, KeyIcon } from '../icons'
import { FileTree } from './FileTree'
import { FileViewer } from './FileViewer'
import { TerminalTabs } from './TerminalTabs'
import { useURLState } from '../../hooks/useURLState'
import { usePermissions } from '../../hooks/usePermissions'
import { queries } from '../../queryOptions'
import { SegmentedControl, type SegmentedControlOption } from '../SegmentedControl'
import { useAgentPrivateSource, useSquadWorkspaceSource, type WorkspaceSource } from './workspaceSource'
import { AgentPrivateStatusBar, WorkspaceTargetSelect } from './AgentPrivateControls'
import { WORKSPACE_AGENT_PARAM } from './agentPrivateTargets'
import type { AgentPrivateStatus } from '../../api/agentPrivate'

export interface WorkspaceTabProps {
  squadId: string
  isTaskTerminal?: boolean
}

const MIN_TERMINAL_HEIGHT = 100
const MAX_TERMINAL_HEIGHT = 800
const DEFAULT_TERMINAL_HEIGHT = 320

type MobilePane = 'files' | 'terminal'

const MOBILE_PANE_OPTIONS: SegmentedControlOption<MobilePane>[] = [
  { value: 'files', label: 'Files' },
  { value: 'terminal', label: 'Terminal' },
]

export function WorkspaceTab({ squadId, isTaskTerminal = false }: WorkspaceTabProps) {
  const [searchParams, setSearchParams] = useSearchParams()
  const agentId = searchParams.get(WORKSPACE_AGENT_PARAM)
  const { can } = usePermissions(squadId)
  const canBrowseAgents = can('agents:private-access')
  const { data: agents } = useQuery({ ...queries.squads.agents(squadId), enabled: canBrowseAgents })

  // One URL update: switching targets also drops the old target's file and shell.
  const selectTarget = useCallback(
    (next: string | null) => {
      setSearchParams(
        (prev) => {
          const params = new URLSearchParams(prev)
          if (next) params.set(WORKSPACE_AGENT_PARAM, next)
          else params.delete(WORKSPACE_AGENT_PARAM)
          params.delete('file')
          params.delete('shell')
          return params
        },
        { replace: true }
      )
    },
    [setSearchParams]
  )

  const targetSelect =
    canBrowseAgents || agentId ? (
      <WorkspaceTargetSelect agents={agents ?? []} value={agentId} onChange={selectTarget} />
    ) : null

  return agentId ? (
    <AgentWorkspace key={agentId} agentId={agentId} toolbar={targetSelect} />
  ) : (
    <SquadWorkspace squadId={squadId} toolbar={targetSelect} isTaskTerminal={isTaskTerminal} />
  )
}

function SquadWorkspace({
  squadId,
  toolbar,
  isTaskTerminal,
}: {
  squadId: string
  toolbar: ReactNode
  isTaskTerminal: boolean
}) {
  const source = useSquadWorkspaceSource(squadId)
  return (
    <WorkspaceLayout
      source={source}
      toolbar={toolbar}
      terminal={(props) => <TerminalTabs sandboxId={`squad_${squadId}`} disabled={isTaskTerminal} {...props} />}
    />
  )
}

function AgentWorkspace({ agentId, toolbar }: { agentId: string; toolbar: ReactNode }) {
  const {
    data: status,
    error,
    isLoading,
  } = useQuery({
    ...queries.agentPrivate.status(agentId),
    // Follow a starting or stopping box until it settles.
    refetchInterval: (query) => {
      const current = query.state.data
      if (!current) return false
      return current.live && current.sandbox.status !== 'running' ? 5000 : 30000
    },
  })
  const source = useAgentPrivateSource(agentId, status?.privateRoot ?? '')

  if (!status) {
    return (
      <div className="h-full min-h-0 flex flex-col gap-2">
        {toolbar && <div className="shrink-0">{toolbar}</div>}
        <Placeholder
          title={isLoading ? 'Loading private folder…' : 'This private folder is not available'}
          detail={
            isLoading
              ? undefined
              : error instanceof Error && 'status' in error && (error as { status: number }).status === 403
                ? 'Browsing an agent’s private folder needs the agents:private-access permission in its squad.'
                : error instanceof Error
                  ? error.message
                  : undefined
          }
        />
      </div>
    )
  }

  const terminalReady = status.canUseTerminal && status.sandbox.status === 'running'
  return (
    <WorkspaceLayout
      source={source}
      toolbar={
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          {toolbar}
          <AgentPrivateStatusBar agentId={agentId} status={status} source={source} />
        </div>
      }
      filesUnavailable={status.filesAvailable ? undefined : filesUnavailableMessage(status)}
      terminal={(props) =>
        terminalReady ? (
          <TerminalTabs key={status.sandboxId} sandboxId={status.sandboxId} {...props} />
        ) : (
          <Placeholder title="Terminal unavailable" detail={terminalUnavailableMessage(status)} />
        )
      }
    />
  )
}

function filesUnavailableMessage(status: AgentPrivateStatus): string {
  if (!status.live)
    return 'This agent is dormant, so its sandbox is stopped. Its private files are available while it is awake.'
  return 'This agent’s sandbox is not running. Start it to browse its private files.'
}

function terminalUnavailableMessage(status: AgentPrivateStatus): string {
  if (!status.live) return 'This agent is dormant. A terminal opens in its own sandbox while the agent is awake.'
  if (!status.canUseTerminal)
    return 'Opening a terminal in an agent’s sandbox also needs the terminal:access permission.'
  return 'Start the agent’s sandbox to open a terminal in it. The shell starts in its private folder.'
}

function Placeholder({ title, detail }: { title: string; detail?: string }) {
  return (
    <div className="h-full flex flex-col items-center justify-center gap-2 rounded-xl bg-surface px-6 py-8 text-center">
      <KeyIcon className="h-6 w-6 text-muted" />
      <p className="text-sm font-medium text-secondary">{title}</p>
      {detail && <p className="max-w-md text-xs text-muted">{detail}</p>}
    </div>
  )
}

interface TerminalSlotProps {
  selectedShell: string | null
  onSelectShell: (shell: string | null) => void
}

function WorkspaceLayout({
  source,
  toolbar,
  terminal,
  filesUnavailable,
}: {
  source: WorkspaceSource
  toolbar: ReactNode
  terminal: (props: TerminalSlotProps) => ReactNode
  /** When set, the file browser shows this instead of the tree. */
  filesUnavailable?: string
}) {
  const [mobilePane, setMobilePane] = useState<MobilePane>('files')

  // File selection synced with URL
  const [selectedFile, setSelectedFile] = useURLState<string | null>({
    param: 'file',
    defaultValue: null,
    serialize: (v) => v,
    deserialize: (v) => v,
  })

  // Shell selection synced with URL
  const [selectedShell, setSelectedShell] = useURLState<string | null>({
    param: 'shell',
    defaultValue: null,
    serialize: (v) => v,
    deserialize: (v) => v,
  })

  // Terminal height state (desktop only)
  const [terminalHeight, setTerminalHeight] = useState(DEFAULT_TERMINAL_HEIGHT)
  const [isResizing, setIsResizing] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  // Handle resize drag (desktop)
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    setIsResizing(true)
  }, [])

  useEffect(() => {
    if (!isResizing) return

    const handleMouseMove = (e: MouseEvent) => {
      if (!containerRef.current) return
      const containerRect = containerRef.current.getBoundingClientRect()
      const newHeight = containerRect.bottom - e.clientY
      setTerminalHeight(Math.min(MAX_TERMINAL_HEIGHT, Math.max(MIN_TERMINAL_HEIGHT, newHeight)))
    }

    const handleMouseUp = () => {
      setIsResizing(false)
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)

    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }
  }, [isResizing])

  const fileTree = filesUnavailable ? (
    <Placeholder title="Files unavailable" detail={filesUnavailable} />
  ) : (
    <FileTree key={source.id} source={source} onSelectFile={setSelectedFile} selectedPath={selectedFile ?? undefined} />
  )
  const terminalSlot = terminal({ selectedShell, onSelectShell: setSelectedShell })

  return (
    <div ref={containerRef} className="h-full min-h-0 flex flex-col">
      {toolbar && <div className="shrink-0 mb-2">{toolbar}</div>}

      {/* Mobile pane switcher */}
      <SegmentedControl
        ariaLabel="Workspace pane"
        className="md:hidden shrink-0 mb-2"
        options={MOBILE_PANE_OPTIONS}
        value={mobilePane}
        onChange={setMobilePane}
      />

      {/* Mobile: Files pane */}
      <div className={clsx('flex-1 min-h-0 flex flex-col md:hidden', mobilePane !== 'files' && 'hidden')}>
        {selectedFile && !filesUnavailable ? (
          <>
            <button
              onClick={() => setSelectedFile(null)}
              className="ficus-button ficus-button-ghost shrink-0 px-3 py-2 text-sm text-accent-light hover:text-link-hover border-b border-th-border bg-surface text-left"
            >
              ← Back to files
            </button>
            <div className="flex-1 min-h-0 overflow-hidden bg-transparent">
              <FileViewer source={source} filePath={selectedFile} />
            </div>
          </>
        ) : (
          <div className="flex-1 min-h-0 overflow-hidden bg-transparent">{fileTree}</div>
        )}
      </div>

      {/* Mobile: Terminal pane */}
      <div className={clsx('flex-1 min-h-0 md:hidden', mobilePane !== 'terminal' && 'hidden')}>{terminalSlot}</div>

      {/* Desktop: File browser section */}
      <div className="hidden md:flex flex-1 min-h-0 gap-3">
        {/* File tree */}
        <div className="w-64 shrink-0 overflow-hidden rounded-xl bg-surface">{fileTree}</div>

        {/* File viewer */}
        <div className="flex-1 min-w-0 overflow-hidden rounded-xl">
          {selectedFile && !filesUnavailable ? (
            <FileViewer source={source} filePath={selectedFile} />
          ) : (
            <div className="h-full flex flex-col items-center justify-center gap-3 px-6 text-center">
              <FileIcon className="h-7 w-7 text-muted" />
              <p className="text-sm font-medium text-secondary">Select a file to view</p>
              <p className="text-xs text-muted">{source.description}</p>
            </div>
          )}
        </div>
      </div>

      {/* Desktop: Resize handle */}
      <div
        onMouseDown={handleMouseDown}
        className={clsx(
          'hidden md:flex h-4 items-center justify-center cursor-ns-resize shrink-0 group',
          isResizing && 'text-accent'
        )}
      >
        <span className="h-1 w-10 rounded-full bg-th-border group-hover:bg-accent transition-colors" />
      </div>

      {/* Desktop: Terminal section */}
      <div
        className="hidden md:block shrink-0 overflow-hidden rounded-xl"
        style={{ height: terminalHeight, maxHeight: '55%' }}
      >
        {terminalSlot}
      </div>
    </div>
  )
}
