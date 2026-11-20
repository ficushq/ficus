/**
 * SystemLogsSection — read-only live tail of Ficus's system logs (API/worker).
 *
 * Streams from /ws/system/logs. Binary frames are log chunks; JSON frames are
 * control messages. Connection is manual: the stream only opens when the user
 * clicks Connect.
 *
 * The log pane fills the rest of the settings page and can open in a full-screen
 * dialog. Lines are parsed by `SystemLogBuffer` and drawn by `SystemLogView`,
 * which follows new lines until the user scrolls up.
 */

import clsx from 'clsx'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { fetchWsTicket } from '../../api/auth'
import { getWsUrl } from '../../api/client'
import { Modal } from '../Modal'
import { MaximizeIcon, MinimizeIcon } from '../icons'
import { buildSystemLogsPath } from './systemLogsUrl'
import { SystemLogBuffer, sameMatch, searchSystemLog, type SystemLogMatch } from './systemLogBuffer'
import { SystemLogView } from './SystemLogView'

type Status = 'idle' | 'connecting' | 'connected' | 'error' | 'closed'
type Component = 'api' | 'worker' | 'all'

export const SYSTEM_LOGS_WRAP_STORAGE_KEY = 'ficus-system-logs-wrap'

const BUTTON = 'ficus-button ficus-button-secondary px-2 py-1 text-xs rounded'
const FIELD = 'ficus-field px-2 py-1 text-xs rounded border border-th-border bg-surface text-primary'

function readWrapPreference(): boolean {
  try {
    return window.localStorage.getItem(SYSTEM_LOGS_WRAP_STORAGE_KEY) !== 'off'
  } catch {
    return true
  }
}

function writeWrapPreference(wrap: boolean) {
  try {
    window.localStorage.setItem(SYSTEM_LOGS_WRAP_STORAGE_KEY, wrap ? 'on' : 'off')
  } catch {
    // Private browsing or a full quota: the toggle still works for this visit.
  }
}

export function SystemLogsSection() {
  const wsRef = useRef<WebSocket | null>(null)
  const epochRef = useRef(0)
  const bufferRef = useRef<SystemLogBuffer | null>(null)
  const frameRef = useRef<number | null>(null)
  const [component, setComponent] = useState<Component>('all')
  const [tailLines, setTailLines] = useState(500)
  const [follow, setFollow] = useState(true)
  const [status, setStatus] = useState<Status>('idle')
  const [search, setSearch] = useState('')
  const [activeMatch, setActiveMatch] = useState<SystemLogMatch | null>(null)
  const [wrap, setWrap] = useState(readWrapPreference)
  const [fullScreen, setFullScreen] = useState(false)
  // Each connection gets a fresh view, so a pause from the previous stream does not carry over.
  const [connection, setConnection] = useState(0)
  const [snapshot, setSnapshot] = useState(() => new SystemLogBuffer().snapshot())

  const buffer = () => (bufferRef.current ??= new SystemLogBuffer())

  // Coalesce bursts of frames into one render per animation frame.
  const flush = useCallback(() => {
    if (frameRef.current !== null) return
    frameRef.current = window.requestAnimationFrame(() => {
      frameRef.current = null
      if (bufferRef.current) setSnapshot(bufferRef.current.snapshot())
    })
  }, [])

  const teardownWs = () => {
    const ws = wsRef.current
    wsRef.current = null
    if (!ws) return
    ws.onopen = null
    ws.onmessage = null
    ws.onerror = null
    ws.onclose = null
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      ws.close(1000, 'client')
    }
  }

  const connect = async () => {
    teardownWs()
    const myEpoch = ++epochRef.current
    const log = buffer()
    log.clear()
    setSnapshot(log.snapshot())
    setActiveMatch(null)
    setConnection((value) => value + 1)
    setStatus('connecting')

    const params: Parameters<typeof buildSystemLogsPath>[0] = { component, tailLines, follow }
    try {
      const { ticket } = await fetchWsTicket()
      if (epochRef.current !== myEpoch) return
      params.ticket = ticket
    } catch {
      if (epochRef.current !== myEpoch) return
      // Ticket minting is optional: the HttpOnly session cookie authenticates this handshake.
    }

    const ws = new WebSocket(getWsUrl() + buildSystemLogsPath(params))
    ws.binaryType = 'arraybuffer'
    wsRef.current = ws
    const decoder = new TextDecoder()

    ws.onopen = () => {
      if (epochRef.current === myEpoch) setStatus('connected')
    }
    ws.onmessage = (event) => {
      if (epochRef.current !== myEpoch) return
      if (event.data instanceof ArrayBuffer) {
        log.appendText(decoder.decode(new Uint8Array(event.data), { stream: true }))
      } else if (typeof event.data === 'string') {
        try {
          const msg = JSON.parse(event.data) as { type: string; message?: string }
          log.appendControl(msg.type === 'error' ? 'error' : 'info', msg.message ?? msg.type)
        } catch {
          log.appendText(event.data)
        }
      }
      flush()
    }
    ws.onerror = () => {
      if (epochRef.current === myEpoch) setStatus('error')
    }
    ws.onclose = (event) => {
      if (epochRef.current !== myEpoch) return
      log.appendText(decoder.decode())
      flush()
      setStatus(event.code === 1000 ? 'closed' : 'error')
    }
  }

  const disconnect = () => {
    epochRef.current++
    teardownWs()
    setStatus('idle')
  }

  useEffect(() => {
    return () => {
      // epochRef is a plain counter (not a DOM-node ref); we deliberately want
      // its latest value at cleanup so an in-flight connect() bails.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      epochRef.current++
      teardownWs()
      if (frameRef.current !== null) window.cancelAnimationFrame(frameRef.current)
    }
  }, [])

  const matches = useMemo(() => searchSystemLog(snapshot, search), [snapshot, search])
  const activeIndex = activeMatch ? matches.findIndex((match) => sameMatch(match, activeMatch)) : -1
  // A match whose line was trimmed from the top of the buffer is no longer active.
  const currentMatch = activeIndex === -1 ? null : matches[activeIndex]

  const step = (direction: 1 | -1) => {
    if (matches.length === 0) return
    const index =
      activeIndex === -1
        ? direction === 1
          ? 0
          : matches.length - 1
        : (activeIndex + direction + matches.length) % matches.length
    setActiveMatch(matches[index])
  }

  const onSearchKey = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter') return
    event.preventDefault()
    // Enter walks back from the newest match, as the terminal search did; Shift+Enter walks forward.
    step(event.shiftKey ? 1 : -1)
  }

  const toggleWrap = (value: boolean) => {
    setWrap(value)
    writeWrapPreference(value)
  }

  const isLive = status === 'connected' || status === 'connecting'
  const statusLabel = status === 'idle' ? 'disconnected' : status
  const emptyText =
    status === 'idle'
      ? 'Connect to stream the latest log lines.'
      : status === 'connecting' || status === 'connected'
        ? 'Waiting for log lines…'
        : 'No log lines were received.'

  const toolbar = (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={component}
          onChange={(event) => setComponent(event.target.value as Component)}
          aria-label="Component"
          className={FIELD}
        >
          <option value="all">All Components</option>
          <option value="api">API</option>
          <option value="worker">Worker</option>
        </select>
        <label className="flex items-center gap-1 text-xs text-muted">
          Tail
          <input
            type="number"
            min={1}
            max={5000}
            value={tailLines}
            onChange={(event) => setTailLines(Math.min(Math.max(1, Number(event.target.value) || 500), 5000))}
            className={clsx(FIELD, 'w-20')}
          />
          lines
        </label>
        <label className="flex items-center gap-1 text-xs text-muted">
          <input type="checkbox" checked={follow} onChange={(event) => setFollow(event.target.checked)} />
          Follow
        </label>
        <label className="flex items-center gap-1 text-xs text-muted">
          <input type="checkbox" checked={wrap} onChange={(event) => toggleWrap(event.target.checked)} />
          Wrap lines
        </label>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={search}
          onChange={(event) => {
            setSearch(event.target.value)
            setActiveMatch(null)
          }}
          onKeyDown={onSearchKey}
          placeholder="Search…"
          aria-label="Search logs"
          title="Enter: previous match · Shift+Enter: next match"
          className={clsx(FIELD, 'w-40')}
        />
        <button type="button" onClick={() => step(-1)} disabled={matches.length === 0} className={BUTTON}>
          Previous
        </button>
        <button type="button" onClick={() => step(1)} disabled={matches.length === 0} className={BUTTON}>
          Next
        </button>
        {search && (
          <span className="text-xs text-muted tabular-nums" aria-live="polite">
            {matches.length === 0
              ? 'No matches'
              : `${activeIndex === -1 ? '–' : activeIndex + 1} / ${matches.length.toLocaleString()}`}
          </span>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2 sm:ml-auto">
        {isLive ? (
          <>
            <button type="button" onClick={connect} className={BUTTON}>
              Reconnect
            </button>
            <button type="button" onClick={disconnect} className={BUTTON}>
              Disconnect
            </button>
          </>
        ) : (
          <button type="button" onClick={connect} className={BUTTON}>
            Connect
          </button>
        )}
        <span
          className={
            status === 'connected'
              ? 'text-xs text-status-success-500'
              : status === 'error'
                ? 'text-xs text-status-danger-500'
                : 'text-xs text-muted'
          }
        >
          {statusLabel}
        </span>
        {!fullScreen && (
          <button
            type="button"
            onClick={() => setFullScreen(true)}
            className="ficus-button ficus-button-ghost inline-flex items-center gap-1 px-2 py-1 text-xs rounded"
            title="Show the logs over the whole window"
          >
            <MaximizeIcon className="h-3.5 w-3.5" />
            Full screen
          </button>
        )}
      </div>
    </div>
  )

  const view = (className: string) => (
    <SystemLogView
      key={connection}
      blocks={snapshot.blocks}
      partial={snapshot.partial}
      appended={snapshot.appended}
      query={search}
      activeMatch={currentMatch}
      wrap={wrap}
      emptyText={emptyText}
      className={className}
    />
  )

  return (
    <div className="flex min-h-full flex-1 flex-col gap-4">
      <div>
        <h3 className="text-lg font-semibold text-primary">Logs</h3>
        <p className="text-sm text-muted mt-1">Live tail of Ficus's own server logs (read-only).</p>
      </div>

      {fullScreen ? (
        <div className="flex min-h-72 flex-1 flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-th-border p-6 text-center">
          <p className="text-sm text-muted">The logs are open in full screen.</p>
          <button type="button" onClick={() => setFullScreen(false)} className={BUTTON}>
            Show here
          </button>
        </div>
      ) : (
        <>
          {toolbar}
          {view('min-h-72 flex-1 overflow-hidden rounded-lg')}
        </>
      )}

      <Modal
        isOpen={fullScreen}
        onClose={() => setFullScreen(false)}
        title="Logs"
        size="viewport"
        mobileFullscreen
        closeOnEscape
        noChildPadding
        headerActions={
          <button
            type="button"
            onClick={() => setFullScreen(false)}
            className="ficus-button ficus-button-ghost inline-flex items-center gap-1 px-2 py-1 text-xs rounded"
            title="Return to the settings page (Escape)"
          >
            <MinimizeIcon className="h-3.5 w-3.5" />
            Exit full screen
          </button>
        }
      >
        {fullScreen && (
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="shrink-0 border-b border-panel-border px-4 py-3">{toolbar}</div>
            {view('min-h-0 flex-1')}
          </div>
        )}
      </Modal>
    </div>
  )
}
