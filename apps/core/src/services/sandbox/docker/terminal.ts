/**
 * Terminal Manager Service
 *
 * Manages PTY sessions for workspace terminals using Docker sandbox containers.
 * Sessions persist across WebSocket reconnections with scrollback buffer.
 * Works with any sandbox ID (task_*, squad_*, etc.).
 */

import { randomBytes } from 'node:crypto'
import type { ServerWebSocket } from 'bun'
import { getSandboxManager } from '../factory'
import { createPeriodicRunner, type PeriodicRunner } from '../../../lib/infra/PeriodicRunner'

import type { IPty } from 'bun-pty'

export interface TerminalSession {
  sessionId: string
  sandboxId: string
  pty: IPty
  lastActivity: number
  clients: Set<ServerWebSocket>
  scrollback: string
  onDataDispose?: { dispose: () => void }
  onExitDispose?: { dispose: () => void }
  exitCode?: number
}

// Control messages sent to clients
export interface SessionMessage {
  type: 'session'
  sessionId: string
}

export interface ScrollbackMessage {
  type: 'scrollback'
  data: string
}

export interface ExitMessage {
  type: 'exit'
  code: number
}

export interface TimeoutMessage {
  type: 'timeout'
}

export type ControlMessage = SessionMessage | ScrollbackMessage | ExitMessage | TimeoutMessage

// Maximum scrollback buffer size (bytes) - ~100KB
const MAX_SCROLLBACK_SIZE = 100 * 1024

// Idle timeout: 1 hour
const IDLE_TIMEOUT_MS = 60 * 60 * 1000

// Check interval: every minute
const CHECK_INTERVAL_MS = 60 * 1000

export class TerminalManager {
  private sessions: Map<string, TerminalSession> = new Map()
  private sandboxSessions: Map<string, Set<string>> = new Map()
  private idleChecker: PeriodicRunner

  constructor(private readonly getManager: () => ReturnType<typeof getSandboxManager> = getSandboxManager) {
    this.idleChecker = createPeriodicRunner({
      name: 'terminal-idle-checker',
      intervalMs: CHECK_INTERVAL_MS,
      runImmediately: false,
      task: async () => this.checkIdleSessions(),
    })
    this.startIdleChecker()
  }

  /**
   * Create a new terminal session for a sandbox.
   * Will ensure the sandbox container is running, creating it if necessary.
   * `cwd` (sandbox-side) overrides where the shell starts.
   */
  async createSession(
    sandboxId: string,
    cols: number = 80,
    rows: number = 24,
    workspacePath?: string,
    cwd?: string
  ): Promise<TerminalSession> {
    const sessionId = randomBytes(16).toString('hex')

    // Lazily ensure the sandbox ONLY when the manager is not already tracking
    // it (container deleted, first use). The WS route ensures the sandbox with
    // its REAL options (squadId, role, …) immediately before calling this, and
    // re-ensuring here with these minimal options is NOT a no-op on the vm
    // runtime: the minimal opts hash to a different provisioning marker, so
    // box-manager's healthy fast path misses and it full-re-provisions —
    // pushing env and RESTARTING the box's systemd unit on every terminal
    // open, then AGAIN (marker ping-pong) on the next 60s keep-warm re-ensure,
    // which killed the just-opened shell with a clean "[Process exited with
    // code 0]".
    if (workspacePath && !this.getManager().hasSandbox(sandboxId)) {
      await this.getManager().ensureSandbox(sandboxId, {
        workspacePath,
        hostAccess: true,
      })
    }

    // Spawn shell inside the Docker sandbox container
    // Pass workspacePath so devbox environment can be auto-activated if available
    const pty = this.getManager().spawnShell(sandboxId, cols, rows, workspacePath, cwd)
    if (!pty) {
      throw new Error(`No sandbox container found for ${sandboxId}. Ensure it has been started.`)
    }

    const session: TerminalSession = {
      sessionId,
      sandboxId,
      pty,
      lastActivity: Date.now(),
      clients: new Set(),
      scrollback: '',
    }

    // Handle PTY output
    session.onDataDispose = pty.onData((data: string) => {
      session.lastActivity = Date.now()
      this.appendScrollback(session, data)
      this.broadcastToClients(session, data)
    })

    // Handle PTY exit
    session.onExitDispose = pty.onExit((e: { exitCode: number; signal?: number | string }) => {
      session.exitCode = e.exitCode
      const exitMsg: ExitMessage = { type: 'exit', code: e.exitCode }
      this.broadcastControlMessage(session, exitMsg)
    })

    // Track session
    this.sessions.set(sessionId, session)

    // Track by sandbox
    if (!this.sandboxSessions.has(sandboxId)) {
      this.sandboxSessions.set(sandboxId, new Set())
    }
    this.sandboxSessions.get(sandboxId)!.add(sessionId)

    return session
  }

  /**
   * Append data to the scrollback buffer (ring buffer).
   */
  private appendScrollback(session: TerminalSession, data: string): void {
    session.scrollback += data
    // Trim from the front if over size limit
    if (session.scrollback.length > MAX_SCROLLBACK_SIZE) {
      session.scrollback = session.scrollback.slice(-MAX_SCROLLBACK_SIZE)
    }
  }

  /**
   * Broadcast binary data to all connected clients.
   */
  private broadcastToClients(session: TerminalSession, data: string): void {
    const buffer = Buffer.from(data, 'utf-8')
    for (const client of session.clients) {
      try {
        client.send(buffer)
      } catch {
        // Client disconnected, will be cleaned up
      }
    }
  }

  /**
   * Broadcast a control message (JSON) to all connected clients.
   */
  private broadcastControlMessage(session: TerminalSession, message: ControlMessage): void {
    const json = JSON.stringify(message)
    for (const client of session.clients) {
      try {
        client.send(json)
      } catch {
        // Client disconnected
      }
    }
  }

  /**
   * Get a session by ID.
   */
  getSession(sessionId: string): TerminalSession | undefined {
    return this.sessions.get(sessionId)
  }

  /**
   * List all active (non-exited) sessions for a sandbox.
   */
  listSessions(sandboxId: string): { sessionId: string; lastActivity: number }[] {
    const sessionIds = this.sandboxSessions.get(sandboxId)
    if (!sessionIds) return []

    return Array.from(sessionIds)
      .map((id) => {
        const session = this.sessions.get(id)
        // Filter out exited sessions
        if (!session || session.exitCode !== undefined) return null
        return {
          sessionId: session.sessionId,
          lastActivity: session.lastActivity,
        }
      })
      .filter((s): s is { sessionId: string; lastActivity: number } => s !== null)
  }

  /**
   * Attach a WebSocket client to a session.
   */
  attachClient(sessionId: string, ws: ServerWebSocket): void {
    const session = this.sessions.get(sessionId)
    if (!session) return

    session.clients.add(ws)
    session.lastActivity = Date.now()

    // Send session info
    const sessionMsg: SessionMessage = { type: 'session', sessionId }
    ws.send(JSON.stringify(sessionMsg))

    // Send scrollback buffer for reconnection
    if (session.scrollback.length > 0) {
      const scrollbackMsg: ScrollbackMessage = {
        type: 'scrollback',
        data: session.scrollback,
      }
      ws.send(JSON.stringify(scrollbackMsg))
    }

    // If session already exited, send exit message
    if (session.exitCode !== undefined) {
      const exitMsg: ExitMessage = { type: 'exit', code: session.exitCode }
      ws.send(JSON.stringify(exitMsg))
    }
  }

  /**
   * Detach a WebSocket client from a session.
   */
  detachClient(sessionId: string, ws: ServerWebSocket): void {
    const session = this.sessions.get(sessionId)
    if (!session) return

    session.clients.delete(ws)
  }

  /**
   * Write data to a session's PTY.
   */
  write(sessionId: string, data: Buffer | string): void {
    const session = this.sessions.get(sessionId)
    if (!session || session.exitCode !== undefined) return

    session.lastActivity = Date.now()
    session.pty.write(typeof data === 'string' ? data : data.toString('utf-8'))
  }

  /**
   * Resize a session's PTY.
   */
  resize(sessionId: string, cols: number, rows: number): void {
    const session = this.sessions.get(sessionId)
    if (!session || session.exitCode !== undefined) return

    session.lastActivity = Date.now()
    session.pty.resize(cols, rows)
  }

  /**
   * Kill a specific session.
   */
  killSession(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) return

    // Clean up event handlers
    session.onDataDispose?.dispose()
    session.onExitDispose?.dispose()

    // Kill the PTY process
    try {
      session.pty.kill()
    } catch {
      // Process may already be dead
    }

    // Notify clients
    const exitMsg: ExitMessage = { type: 'exit', code: session.exitCode ?? -1 }
    this.broadcastControlMessage(session, exitMsg)

    // Close all client connections
    for (const client of session.clients) {
      try {
        client.close(1000, 'Session terminated')
      } catch {
        // Already closed
      }
    }

    // Remove from tracking
    this.sessions.delete(sessionId)
    const sandboxSessions = this.sandboxSessions.get(session.sandboxId)
    if (sandboxSessions) {
      sandboxSessions.delete(sessionId)
      if (sandboxSessions.size === 0) {
        this.sandboxSessions.delete(session.sandboxId)
      }
    }
  }

  /** Whether any session (live or exited but not yet removed) exists for a sandbox. */
  hasSessions(sandboxId: string): boolean {
    return this.sandboxSessions.has(sandboxId)
  }

  /**
   * Kill all sessions for a sandbox.
   */
  killSandboxSessions(sandboxId: string): void {
    const sessionIds = this.sandboxSessions.get(sandboxId)
    if (!sessionIds) return

    // Copy the set since killSession modifies it
    for (const sessionId of Array.from(sessionIds)) {
      this.killSession(sessionId)
    }
  }

  /**
   * Check for idle sessions and kill them.
   */
  private checkIdleSessions(): void {
    const now = Date.now()
    for (const [sessionId, session] of this.sessions) {
      if (now - session.lastActivity > IDLE_TIMEOUT_MS) {
        // Warn clients before killing
        const timeoutMsg: TimeoutMessage = { type: 'timeout' }
        this.broadcastControlMessage(session, timeoutMsg)

        // Give clients a moment to see the message, then kill
        setTimeout(() => {
          this.killSession(sessionId)
        }, 1000)
      }
    }
  }

  /**
   * Start the idle session checker.
   */
  private startIdleChecker(): void {
    this.idleChecker.start()
  }

  /**
   * Clean up all sessions (called on shutdown).
   */
  cleanup(): void {
    void this.idleChecker.stop()

    for (const sessionId of Array.from(this.sessions.keys())) {
      this.killSession(sessionId)
    }
  }
}

// Singleton instance
export const terminalManager = new TerminalManager()
