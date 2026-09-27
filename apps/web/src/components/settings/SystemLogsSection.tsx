import { observeTerminalTheme, readTerminalTheme } from '../../theme/terminal'
/**
 * SystemLogsSection — read-only live tail of Ficus's system logs (API/worker).
 *
 * Streams from /ws/system/logs. Binary frames are log chunks; JSON frames are
 * control messages. Connection is manual: the stream only opens when the user
 * clicks Connect.
 */

import { useEffect, useRef, useState } from 'react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { fetchWsTicket } from '../../api/auth'
import { getWsUrl } from '../../api/client'
import { buildSystemLogsPath } from './systemLogsUrl'
import '@xterm/xterm/css/xterm.css'

type Status = 'idle' | 'connecting' | 'connected' | 'error' | 'closed'
type Component = 'api' | 'worker' | 'all'

export function SystemLogsSection() {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<XTerm | null>(null)
  const searchRef = useRef<SearchAddon | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const epochRef = useRef(0)
  const [component, setComponent] = useState<Component>('all')
  const [tailLines, setTailLines] = useState(500)
  const [follow, setFollow] = useState(true)
  const [status, setStatus] = useState<Status>('idle')
  const [search, setSearch] = useState('')

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
    ws.onclose = (event) => {
      if (epochRef.current === myEpoch) setStatus(event.code === 1000 ? 'closed' : 'error')
    }
  }

  const disconnect = () => {
    epochRef.current++
    teardownWs()
    setStatus('idle')
  }

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

  useEffect(() => {
    return () => {
      // epochRef is a plain counter (not a DOM-node ref); we deliberately want
      // its latest value at cleanup so an in-flight connect() bails.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      epochRef.current++
      teardownWs()
    }
  }, [])

  const onSearchKey = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') searchRef.current?.findPrevious(search)
  }

  const isLive = status === 'connected' || status === 'connecting'
  const statusLabel = status === 'idle' ? 'disconnected' : status

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-semibold text-primary">Logs</h3>
        <p className="text-sm text-muted mt-1">Live tail of Ficus's own server logs (read-only).</p>
      </div>

      <div className="ficus-section py-5">
        <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
          <div className="flex items-center gap-2 flex-wrap">
            <select
              value={component}
              onChange={(event) => setComponent(event.target.value as Component)}
              className="ficus-field px-2 py-1 text-xs rounded border border-th-border bg-surface text-primary"
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
                className="ficus-field w-20 px-2 py-1 text-xs rounded border border-th-border bg-surface text-primary"
              />
              lines
            </label>
            <label className="flex items-center gap-1 text-xs text-muted">
              <input type="checkbox" checked={follow} onChange={(event) => setFollow(event.target.checked)} />
              Follow
            </label>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
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
        <div ref={containerRef} className="w-full h-96 bg-[rgb(var(--log-bg))] rounded-lg overflow-hidden" />
      </div>
    </div>
  )
}
