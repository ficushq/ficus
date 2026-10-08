/**
 * WorkspaceTab Component
 *
 * Main workspace view combining file browser and terminal.
 * Desktop layout:
 * - Top: FileTree (left) + FileViewer (right)
 * - Bottom: TerminalTabs (resizable)
 * Mobile layout:
 * - Tab switcher: Files | Terminal
 * - Files view: FileTree (full width, selecting a file shows FileViewer)
 */

import { useState, useCallback, useRef, useEffect } from 'react'
import clsx from 'clsx'
import { FileIcon } from '../icons'
import { FileTree } from './FileTree'
import { FileViewer } from './FileViewer'
import { TerminalTabs } from './TerminalTabs'
import { useURLState } from '../../hooks/useURLState'
import { SegmentedControl, type SegmentedControlOption } from '../SegmentedControl'

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

  const sandboxId = `squad_${squadId}`

  return (
    <div ref={containerRef} className="h-full min-h-0 flex flex-col">
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
        {selectedFile ? (
          <>
            <button
              onClick={() => setSelectedFile(null)}
              className="ficus-button ficus-button-ghost shrink-0 px-3 py-2 text-sm text-accent-light hover:text-link-hover border-b border-th-border bg-surface text-left"
            >
              ← Back to files
            </button>
            <div className="flex-1 min-h-0 overflow-hidden bg-transparent">
              <FileViewer squadId={squadId} filePath={selectedFile} />
            </div>
          </>
        ) : (
          <div className="flex-1 min-h-0 overflow-hidden bg-transparent">
            <FileTree squadId={squadId} onSelectFile={setSelectedFile} selectedPath={selectedFile ?? undefined} />
          </div>
        )}
      </div>

      {/* Mobile: Terminal pane */}
      <div className={clsx('flex-1 min-h-0 md:hidden', mobilePane !== 'terminal' && 'hidden')}>
        <TerminalTabs
          sandboxId={sandboxId}
          selectedShell={selectedShell}
          onSelectShell={setSelectedShell}
          disabled={isTaskTerminal}
        />
      </div>

      {/* Desktop: File browser section */}
      <div className="hidden md:flex flex-1 min-h-0 gap-3">
        {/* File tree */}
        <div className="w-64 shrink-0 overflow-hidden rounded-xl bg-surface">
          <FileTree squadId={squadId} onSelectFile={setSelectedFile} selectedPath={selectedFile ?? undefined} />
        </div>

        {/* File viewer */}
        <div className="flex-1 min-w-0 overflow-hidden rounded-xl">
          {selectedFile ? (
            <FileViewer squadId={squadId} filePath={selectedFile} />
          ) : (
            <div className="h-full flex flex-col items-center justify-center gap-3 px-6 text-center">
              <FileIcon className="h-7 w-7 text-muted" />
              <p className="text-sm font-medium text-secondary">Select a file to view</p>
              <p className="text-xs text-muted">Browse your squad’s shared workspace.</p>
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
        <TerminalTabs
          sandboxId={sandboxId}
          selectedShell={selectedShell}
          onSelectShell={setSelectedShell}
          disabled={isTaskTerminal}
        />
      </div>
    </div>
  )
}
