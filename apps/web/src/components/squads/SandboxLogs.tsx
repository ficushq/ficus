import { observeTerminalTheme, readTerminalTheme } from '../../theme/terminal'
/**
 * SandboxLogs — read-only live tail of a squad sandbox's container logs.
 *
 * Streams from /ws/sandbox/<sandboxId>/logs. Binary frames are log chunks;
 * JSON frames are control messages. Does not create the sandbox.
 *
 * Connection is manual: the stream only opens when the user clicks Connect.
 * Every socket runs under an epoch; handlers from a superseded socket are
 * detached on teardown and additionally no-op if the epoch has moved on, so a
 * discarded socket can never clobber the live connection's UI state.
 */

import { useEffect, useRef, useState } from 'react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { getStoredToken, getWsUrl } from '../../api/client'
import { fetchWsTicket } from '../../api/auth'
import { buildSandboxLogsPath } from './sandboxLogsUrl'
import '@xterm/xterm/css/xterm.css'

interface Props {
  squadId: string
}

type Status = 'idle' | 'connecting' | 'connected' | 'error' | 'closed'

const SANDBOX_PREFIX = 'squad_'

export function SandboxLogs({ squadId }: Props) {
  const sandboxId = `${SANDBOX_PREFIX}${squadId}`
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<XTerm | null>(null)
  const searchRef = useRef<SearchAddon | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  // Bumped on every (re)connect/disconnect/unmount; a socket's handlers only
  // act while their captured epoch is still current.
  const epochRef = useRef(0)
  const [previous, setPrevious] = useState(false)
  const [status, setStatus] = useState<Status>('idle')
  const [search, setSearch] = useState('')

  // Detach a socket's handlers and close it. After this the socket can never
  // mutate UI state again, regardless of when its close/error finally fires.
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
    const term = termRef.current
    if (!term || !containerRef.current) return
    teardownWs()
    const myEpoch = ++epochRef.current
    term.clear()
    setStatus('connecting')

    const params: Parameters<typeof buildSandboxLogsPath>[0] = { sandboxId, tailLines: 500, previous }
    try {
      const { ticket } = await fetchWsTicket()
      if (epochRef.current !== myEpoch) return // superseded during the await
      params.ticket = ticket
    } catch {
      if (epochRef.current !== myEpoch) return
      params.token = getStoredToken() || ''
    }

    const ws = new WebSocket(getWsUrl() + buildSandboxLogsPath(params))
    ws.binaryType = 'arraybuffer'
    wsRef.current = ws

    ws.onopen = () => {
      if (epochRef.current === myEpoch) setStatus('connected')
    }
    ws.onmessage = (event) => {
      if (epochRef.current !== myEpoch) return
      if (event.data instanceof ArrayBuffer) {
        term.write(new Uint8Array(event.data))
        return
      }
      if (typeof event.data === 'string') {
        try {
          const msg = JSON.parse(event.data) as { type: string; message?: string }
          const color = msg.type === 'error' ? '31' : '33'
          term.write(`\r\n\x1b[${color}m[${msg.message ?? msg.type}]\x1b[0m\r\n`)
        } catch {
          term.write(event.data)
        }
      }
    }
    ws.onerror = () => {
      if (epochRef.current === myEpoch) setStatus('error')
    }
    ws.onclose = (e) => {
      if (epochRef.current === myEpoch) setStatus(e.code === 1000 ? 'closed' : 'error')
    }
  }

  const disconnect = () => {
    epochRef.current++ // invalidate the live socket's handlers
    teardownWs()
    setStatus('idle')
  }

  // Create the terminal once.
  useEffect(() => {
    if (!containerRef.current) return
    const term = new XTerm({
      theme: readTerminalTheme(window.getComputedStyle(document.documentElement), 'log'),
      fontFamily: '"JetBrains Mono", monospace',
      fontSize: 12,
      disableStdin: true,
      cursorBlink: false,
      scrollback: 10000,
      convertEol: true,
    })
    const fit = new FitAddon()
    const searchAddon = new SearchAddon()
    term.loadAddon(fit)
    term.loadAddon(searchAddon)
    const stopThemeObserver = observeTerminalTheme(term, containerRef.current, 'log')
    term.open(containerRef.current)
    fit.fit()
    termRef.current = term
    searchRef.current = searchAddon
    const ro = new ResizeObserver(() => fit.fit())
    ro.observe(containerRef.current)
    return () => {
      ro.disconnect()
      stopThemeObserver()
      term.dispose()
      termRef.current = null
    }
  }, [])

  // Tear down any open socket on unmount.
  useEffect(() => {
    return () => {
      // epochRef is a plain counter (not a DOM-node ref); we deliberately want
      // its latest value at cleanup so an in-flight connect() bails.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      epochRef.current++
      teardownWs()
    }
  }, [])

  const onSearchKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') searchRef.current?.findPrevious(search) // search upward (toward older lines)
  }

  const isLive = status === 'connected' || status === 'connecting'
  const statusLabel = status === 'idle' ? 'disconnected' : status

  return (
    <div className="mt-6">
      <div className="flex items-center justify-between mb-2">
        <div>
          <h3 className="text-sm font-medium text-primary">Sandbox Logs</h3>
          <p className="text-xs text-muted mt-1">Live tail of the sandbox container logs (read-only).</p>
        </div>
        <div className="flex items-center gap-2">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={onSearchKey}
            placeholder="Search…"
            className="ficus-field w-40 px-2 py-1 text-xs rounded border border-th-border bg-surface text-primary"
          />
          <button
            onClick={() => searchRef.current?.findNext(search)}
            className="ficus-button px-2 py-1 text-xs rounded border border-th-border text-primary"
          >
            Next
          </button>
          <label className="flex items-center gap-1 text-xs text-muted">
            <input type="checkbox" checked={previous} onChange={(e) => setPrevious(e.target.checked)} />
            Previous (crashed)
          </label>
          {isLive ? (
            <>
              <button
                onClick={connect}
                className="ficus-button px-2 py-1 text-xs rounded border border-th-border text-primary"
              >
                Reconnect
              </button>
              <button
                onClick={disconnect}
                className="ficus-button px-2 py-1 text-xs rounded border border-th-border text-primary"
              >
                Disconnect
              </button>
            </>
          ) : (
            <button
              onClick={connect}
              className="ficus-button px-2 py-1 text-xs rounded border border-th-border text-primary"
            >
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
        </div>
      </div>
      <div ref={containerRef} className="w-full h-80 bg-[rgb(var(--log-bg))] rounded-lg overflow-hidden" />
    </div>
  )
}
