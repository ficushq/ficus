/**
 * Terminal WebSocket Handler
 *
 * WebSocket endpoint for terminal I/O at /ws/terminal.
 * Handles binary frames for terminal data and JSON frames for control messages.
 * Sandbox IDs for squads are formatted as 'squad_<uuid>'.
 */

import type { ServerWebSocket } from 'bun'
import type { Context } from 'hono'
import { terminalManager } from '../sandbox/docker/terminal'
import { getSquadIdFromSandbox } from '../sandbox/types'
import { ensureSquadSandbox } from '../sandbox/ensure'
import { WSEvents } from 'hono/ws'
import { Squad } from '../../entities/Squad'
import { createLogger } from '../../lib/infra/logger'
import { SandboxProvisionError } from '../sandbox/k8s/provision-errors'
import { parseAgentSandboxId, resolveAgentPrivateTarget, type AgentPrivateTarget } from '../agent-private/access'
import { startAgentSandbox, type StartAgentSandboxOutcome } from '../agent-private/sandbox'
import { agentVisiblePrivateRoot } from '../agent-private/files'

const log = createLogger('terminal')

export function getProvisioningWebSocketClose(error: unknown): { code: 1013; reason: string } | null {
  if (!(error instanceof SandboxProvisionError)) return null
  const retry = error.retryAfterMs == null ? '' : ` Retry in ${Math.ceil(error.retryAfterMs / 1_000)}s.`
  return { code: 1013, reason: `Sandbox temporarily unavailable.${retry}`.slice(0, 123) }
}

// Track session ID for each WebSocket connection
const wsSessionMap = new WeakMap<ServerWebSocket, string>()

interface ResizeMessage {
  type: 'resize'
  cols: number
  rows: number
}

function isResizeMessage(data: unknown): data is ResizeMessage {
  return (
    typeof data === 'object' &&
    data !== null &&
    (data as ResizeMessage).type === 'resize' &&
    typeof (data as ResizeMessage).cols === 'number' &&
    typeof (data as ResizeMessage).rows === 'number'
  )
}

/**
 * Create WebSocket handlers for terminal connections.
 */
/** Where a terminal's shell starts, or why the socket is closed instead. */
export type TerminalSandboxPreparation =
  | { ok: true; workspacePath?: string; cwd?: string }
  | { ok: false; code: number; reason: string }

export interface TerminalSandboxDeps {
  findSquad: (squadId: string) => Promise<Squad | null>
  ensureSquad: (squad: Squad) => Promise<string>
  findAgentTarget: (agentId: string) => Promise<AgentPrivateTarget | null>
  startAgent: (target: AgentPrivateTarget) => Promise<StartAgentSandboxOutcome>
  privateRoot: (target: AgentPrivateTarget) => string
}

const defaultTerminalSandboxDeps: TerminalSandboxDeps = {
  findSquad: (squadId) => Squad.find(squadId),
  ensureSquad: (squad) => ensureSquadSandbox(squad),
  findAgentTarget: resolveAgentPrivateTarget,
  startAgent: (target) => startAgentSandbox(target),
  privateRoot: agentVisiblePrivateRoot,
}

/**
 * Ensure the sandbox behind a terminal (lazily creating it if needed).
 *
 * - `squad_<id>`: the shared squad box, shell in the squad workspace.
 * - `agent_<id>`: the agent's own box, ensured through the same path as the
 *   warmups (no execution, no status change, so the agent is not woken), shell
 *   in the agent's private dir. A dormant agent's box is not started.
 *
 * Authorization happened at the upgrade (authorizeTerminalRequest); the agent
 * is re-read here from its row so a stale or spoofed id cannot pick the box.
 */
export async function prepareTerminalSandbox(
  sandboxId: string,
  deps: TerminalSandboxDeps = defaultTerminalSandboxDeps
): Promise<TerminalSandboxPreparation> {
  const squadId = getSquadIdFromSandbox(sandboxId)
  if (squadId) {
    log.info(`Ensuring squad sandbox for terminal: ${sandboxId}`)
    const squad = await deps.findSquad(squadId)
    if (!squad) {
      log.error(`Squad not found: ${squadId}`)
      return { ok: false, code: 4004, reason: 'Squad not found' }
    }
    return { ok: true, workspacePath: await deps.ensureSquad(squad) }
  }
  const agentId = parseAgentSandboxId(sandboxId)
  if (agentId) {
    const target = await deps.findAgentTarget(agentId)
    if (!target || target.sandboxId !== sandboxId) return { ok: false, code: 4004, reason: 'Agent sandbox not found' }
    log.info(`Ensuring agent sandbox for terminal: ${sandboxId}`)
    const started = await deps.startAgent(target)
    if (!started.ok) return { ok: false, code: 4009, reason: started.message.slice(0, 123) }
    return { ok: true, cwd: deps.privateRoot(target) }
  }
  log.error(`Unknown sandbox type: ${sandboxId}`)
  return { ok: false, code: 4004, reason: 'Unknown sandbox type' }
}

/**
 * Create WebSocket handlers for terminal connections. `actor` (the audit label
 * of the authorized person) is logged when a session is opened or resumed.
 */
export function createTerminalWebSocketHandlers(
  sandboxId: string,
  sessionId: string | null,
  actor = 'unknown'
): WSEvents<ServerWebSocket> {
  return {
    async onOpen(_event, ws) {
      if (!ws.raw) return

      try {
        // Ensure sandbox exists — lazily create if not yet running
        // Always try to ensure sandbox (handles deleted containers, restarts, etc.)
        let prepared: TerminalSandboxPreparation
        try {
          prepared = await prepareTerminalSandbox(sandboxId)
        } catch (error) {
          const provisioningClose = getProvisioningWebSocketClose(error)
          if (provisioningClose) {
            ws.raw.close(provisioningClose.code, provisioningClose.reason)
            return
          }
          log.error(`Failed to ensure sandbox ${sandboxId}:`, error)
          ws.raw.close(4004, 'Failed to create sandbox')
          return
        }
        if (!prepared.ok) {
          ws.raw.close(prepared.code, prepared.reason)
          return
        }

        let session
        if (sessionId) {
          // Reattach to existing session
          session = terminalManager.getSession(sessionId)
          if (!session) {
            ws.raw.close(4004, 'Session not found')
            return
          }
          if (session.sandboxId !== sandboxId) {
            ws.raw.close(4003, 'Session does not belong to this sandbox')
            return
          }
        } else {
          // Create new session with workspacePath for devbox activation
          session = await terminalManager.createSession(sandboxId, 80, 24, prepared.workspacePath, prepared.cwd)
        }
        log.info(
          `Terminal session ${session.sessionId} ${sessionId ? 'resumed' : 'opened'} in ${sandboxId} by ${actor}`
        )

        // Track the session for this WebSocket
        wsSessionMap.set(ws.raw, session.sessionId)

        // Attach client to session
        terminalManager.attachClient(session.sessionId, ws.raw)
      } catch (error) {
        log.error('Error in terminal WebSocket onOpen:', error)
        ws.raw.close(4500, 'Internal server error')
      }
    },

    onMessage(event, ws) {
      if (!ws.raw) return

      const sessionId = wsSessionMap.get(ws.raw)
      if (!sessionId) return

      const data = event.data

      // Binary data: forward to PTY
      if (data instanceof ArrayBuffer || data instanceof Uint8Array) {
        const buffer = data instanceof ArrayBuffer ? Buffer.from(data) : Buffer.from(data.buffer)
        terminalManager.write(sessionId, buffer)
        return
      }

      // String data: could be binary-as-string or JSON control message
      if (typeof data === 'string') {
        // Try to parse as JSON control message
        try {
          const parsed = JSON.parse(data)
          if (isResizeMessage(parsed)) {
            terminalManager.resize(sessionId, parsed.cols, parsed.rows)
            return
          }
        } catch {
          // Not JSON, treat as terminal input
        }

        // Forward as terminal input
        terminalManager.write(sessionId, data)
      }
    },

    onClose(_event, ws) {
      if (!ws.raw) return
      const sessionId = wsSessionMap.get(ws.raw)
      if (sessionId) {
        terminalManager.detachClient(sessionId, ws.raw)
        wsSessionMap.delete(ws.raw)
      }
    },

    onError(event, ws) {
      if (!ws.raw) return
      log.error('Terminal WebSocket error:', event)
      const sessionId = wsSessionMap.get(ws.raw)
      if (sessionId) {
        terminalManager.detachClient(sessionId, ws.raw)
        wsSessionMap.delete(ws.raw)
      }
    },
  }
}

/**
 * Extract terminal WebSocket parameters from the request context.
 * Accepts sandboxId directly, or taskId/squadId for convenience (converted to sandbox ID).
 */
export function getTerminalParams(c: Context): { sandboxId: string; sessionId: string | null } | null {
  const url = new URL(c.req.url)
  const sessionId = url.searchParams.get('sessionId')

  // Direct sandbox ID (preferred)
  const sandboxId = url.searchParams.get('sandboxId')
  if (sandboxId) {
    return { sandboxId, sessionId }
  }

  // squadId → squad_<squadId>
  const squadId = url.searchParams.get('squadId')
  if (squadId) {
    return { sandboxId: Squad.getSandboxId(squadId), sessionId }
  }

  return null
}
