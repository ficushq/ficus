/**
 * Terminal Component
 *
 * xterm.js terminal with WebSocket connection to the backend terminal manager.
 * Supports creating new sessions or reattaching to existing ones.
 */

import { useEffect, useRef, useCallback, useState } from 'react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { getStoredToken, getWsUrl } from '../../api/client'
import { fetchWsTicket } from '../../api/auth'
import { useStableRef } from '../../hooks/useStableRef'
import '@xterm/xterm/css/xterm.css'
import { observeTerminalTheme, readTerminalTheme } from '../../theme/terminal'

export interface TerminalProps {
  sandboxId: string
  sessionId?: string
  isActive?: boolean
  onSessionCreated?: (sessionId: string) => void
  onSessionExit?: () => void
}

// Control messages from server
interface SessionMessage {
  type: 'session'
  sessionId: string
}

interface ScrollbackMessage {
  type: 'scrollback'
  data: string
}

interface ExitMessage {
  type: 'exit'
  code: number
}

interface TimeoutMessage {
  type: 'timeout'
}

type ControlMessage = SessionMessage | ScrollbackMessage | ExitMessage | TimeoutMessage

export function Terminal({ sandboxId, sessionId, isActive = true, onSessionCreated, onSessionExit }: TerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<XTerm | null>(null)
  const stopThemeObserverRef = useRef<(() => void) | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const resizeObserverRef = useRef<ResizeObserver | null>(null)
  // Store initial sessionId in ref so we don't reconnect when it changes
  const sessionIdRef = useRef(sessionId)
  // Track if we've started the WebSocket (set only inside connectTimeout so remount can retry)
  const initializedRef = useRef(false)
  const startingMsgTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  // Counter to retry initialization when container gets size
  const [initRetry, setInitRetry] = useState(0)
  // Connection status for UI indicator
  const [connectionStatus, setConnectionStatus] = useState<'idle' | 'connecting' | 'connected' | 'error'>('idle')

  // Store callbacks in refs to avoid recreating WebSocket when they change
  const onSessionCreatedRef = useStableRef(onSessionCreated)
  const onSessionExitRef = useStableRef(onSessionExit)

  // Refit terminal when becoming active (container may have resized while hidden)
  useEffect(() => {
    if (isActive && fitAddonRef.current && terminalRef.current) {
      // Small delay to ensure container has correct dimensions
      const timer = setTimeout(() => {
        fitAddonRef.current?.fit()
        if (terminalRef.current && wsRef.current?.readyState === WebSocket.OPEN) {
          wsRef.current.send(
            JSON.stringify({
              type: 'resize',
              cols: terminalRef.current.cols,
              rows: terminalRef.current.rows,
            })
          )
        }
      }, 10)
      return () => clearTimeout(timer)
    }
  }, [isActive])

  // Handle incoming WebSocket messages
  const handleMessage = useCallback((event: MessageEvent) => {
    // Binary data: terminal output
    if (event.data instanceof ArrayBuffer || event.data instanceof Blob) {
      if (event.data instanceof Blob) {
        event.data.arrayBuffer().then((buffer) => {
          const text = new TextDecoder().decode(buffer)
          terminalRef.current?.write(text)
        })
      } else {
        const text = new TextDecoder().decode(event.data)
        terminalRef.current?.write(text)
      }
      return
    }

    // String data: JSON control message
    if (typeof event.data === 'string') {
      try {
        const message = JSON.parse(event.data) as ControlMessage

        switch (message.type) {
          case 'session':
            // Shell session is now ready — clear status and show terminal
            clearTimeout(startingMsgTimerRef.current)
            setConnectionStatus('connected')
            terminalRef.current?.write('\x1b[2K\r') // clear status line
            onSessionCreatedRef.current?.(message.sessionId)
            break

          case 'scrollback':
            // Clear terminal and write scrollback
            terminalRef.current?.clear()
            terminalRef.current?.write(message.data)
            break

          case 'exit':
            terminalRef.current?.write(`\r\n\x1b[33m[Process exited with code ${message.code}]\x1b[0m\r\n`)
            onSessionExitRef.current?.()
            break

          case 'timeout':
            terminalRef.current?.write('\r\n\x1b[33m[Session timed out after 1 hour of inactivity]\x1b[0m\r\n')
            onSessionExitRef.current?.()
            break
        }
      } catch {
        // Not JSON, treat as terminal output
        terminalRef.current?.write(event.data)
      }
    }
  }, [])

  // Send resize message to server
  const sendResize = useCallback((cols: number, rows: number) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'resize', cols, rows }))
    }
  }, [])

  // Initialize terminal and WebSocket (only once when first becomes active and has size)
  useEffect(() => {
    // Skip if already initialized or not active yet
    if (initializedRef.current || !isActive) return
    if (!containerRef.current) return

    // Check container has non-zero dimensions (xterm crashes on zero-size)
    const rect = containerRef.current.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) {
      // Retry after a short delay
      const timerId = setTimeout(() => setInitRetry((r) => r + 1), 50)
      return () => clearTimeout(timerId)
    }

    // Track if this effect instance is still active (handles StrictMode double-mount)
    let isMounted = true
    const container = containerRef.current

    // Delay terminal + WebSocket setup so we only run once (avoids double setup on remount)
    const connectTimeout = setTimeout(async () => {
      if (!isMounted) return
      // Re-check container in case it was unmounted or resized to zero
      if (!containerRef.current || containerRef.current !== container) return
      const rect = container.getBoundingClientRect()
      if (rect.width === 0 || rect.height === 0) return

      initializedRef.current = true

      setConnectionStatus('connecting')

      // Create terminal and attach to container (once)
      const terminal = new XTerm({
        theme: readTerminalTheme(window.getComputedStyle(document.documentElement)),
        fontFamily: '"JetBrains Mono", "Fira Code", "Source Code Pro", monospace',
        fontSize: 13,
        lineHeight: 1.2,
        cursorBlink: true,
        cursorStyle: 'block',
        allowProposedApi: true,
      })

      const fitAddon = new FitAddon()
      const webLinksAddon = new WebLinksAddon()

      terminal.loadAddon(fitAddon)
      terminal.loadAddon(webLinksAddon)

      stopThemeObserverRef.current = observeTerminalTheme(terminal, container)
      terminal.open(container)
      fitAddon.fit()

      terminalRef.current = terminal
      fitAddonRef.current = fitAddon

      terminal.write('\x1b[33m[Connecting...]\x1b[0m')
      // The backend always ensures the sandbox before attaching a shell. That
      // can take a moment even when the pod is already running, so avoid saying
      // we are starting the sandbox unless the backend explicitly reports that.
      startingMsgTimerRef.current = setTimeout(() => {
        terminal.write('\x1b[2K\r\x1b[33m[Preparing terminal...]\x1b[0m')
      }, 2000)

      // Resize observer
      const resizeObserver = new ResizeObserver(() => {
        if (fitAddonRef.current && terminalRef.current) {
          fitAddonRef.current.fit()
          sendResize(terminalRef.current.cols, terminalRef.current.rows)
        }
      })
      resizeObserver.observe(container)
      resizeObserverRef.current = resizeObserver

      // WebSocket connection. Prefer a single-use ticket so the session bearer
      // isn't placed in the URL; fall back to the stored token in no-auth/legacy
      // mode (where ticket minting is rejected).
      const params = new URLSearchParams({ sandboxId })
      try {
        const { ticket } = await fetchWsTicket()
        params.set('ticket', ticket)
      } catch {
        params.set('token', getStoredToken() || '')
      }
      if (!isMounted) return
      if (sessionIdRef.current) {
        params.set('sessionId', sessionIdRef.current)
      }
      const wsUrl = getWsUrl() + `/terminal?${params}`

      const ws = new WebSocket(wsUrl)
      ws.binaryType = 'arraybuffer'
      wsRef.current = ws

      ws.onopen = () => {
        if (!isMounted) return
        // WebSocket to core is open, but shell isn't ready yet —
        // core is still ensuring the sandbox. Send resize early so
        // it's available when the shell spawns.
        sendResize(terminal.cols, terminal.rows)
      }

      ws.onmessage = handleMessage

      ws.onclose = (event) => {
        if (isMounted && event.code !== 1000) {
          setConnectionStatus('error')
          terminal.write(`\r\n\x1b[31m[Connection closed: ${event.reason || 'Unknown error'}]\x1b[0m\r\n`)
        }
      }

      ws.onerror = () => {
        if (isMounted) {
          setConnectionStatus('error')
          terminal.write('\r\n\x1b[31m[WebSocket error]\x1b[0m\r\n')
        }
      }

      terminal.onData((data) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(new TextEncoder().encode(data))
        }
      })
    }, 50)

    // Cleanup: cancel pending setup. If timeout ran we have refs set; tear down.
    return () => {
      isMounted = false
      clearTimeout(connectTimeout)
      clearTimeout(startingMsgTimerRef.current)
    }
    // Only run when sandboxId changes or first becomes active
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sandboxId, isActive, initRetry])

  // Cleanup on unmount only (not on dep changes)
  useEffect(() => {
    return () => {
      resizeObserverRef.current?.disconnect()
      resizeObserverRef.current = null
      const ws = wsRef.current
      wsRef.current = null
      if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
        ws.close(1000, 'Component unmounted')
      }
      stopThemeObserverRef.current?.()
      stopThemeObserverRef.current = null
      terminalRef.current?.dispose()
      terminalRef.current = null
      fitAddonRef.current = null
      initializedRef.current = false
    }
  }, [])

  return (
    <div
      ref={containerRef}
      className="w-full h-full ficus-terminal bg-[rgb(var(--term-bg))] relative"
      aria-busy={connectionStatus === 'connecting'}
    >
      {connectionStatus === 'connecting' && (
        <span className="sr-only" aria-live="polite">
          Connecting to terminal…
        </span>
      )}
    </div>
  )
}
