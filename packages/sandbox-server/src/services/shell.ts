/**
 * Interactive shell (PTY) service via WebSocket.
 *
 * The client sends JSON messages:
 *   { spawn: { cols, rows, cwd?, useDevboxRc? } }  — first message, creates PTY
 *   { data: "<base64>" }                            — stdin data
 *   { resize: { cols, rows } }                      — resize terminal
 *   { kill: true }                                  — kill shell
 *
 * The server sends JSON messages:
 *   { data: "<base64>" }                            — PTY output
 *   { exitCode: number }                            — shell exited
 *   { error: "message" }                            — error
 */

import { spawn as ptySpawn, type IPty } from 'bun-pty'
import { getWorkspace, getDevboxBashrcPath } from '../paths'
import { existsSync } from 'fs'
import type { ServerWebSocket } from 'bun'
import { buildSandboxChildEnv } from './env'

interface ShellSpawn {
  cols: number
  rows: number
  cwd?: string
  useDevboxRc?: boolean
  /** Per-session env overrides (applied last, over the pod's baked env). */
  env?: Record<string, string>
}

interface ShellMessage {
  spawn?: ShellSpawn
  data?: string // base64
  resize?: { cols: number; rows: number }
  kill?: boolean
}

export function handleShell(ws: ServerWebSocket<unknown>): void {
  let ptyProcess: IPty | null = null

  const cleanup = () => {
    if (ptyProcess) {
      ptyProcess.kill()
      ptyProcess = null
    }
  }

  const onMessage = (raw: string | Buffer) => {
    let msg: ShellMessage
    try {
      msg = JSON.parse(typeof raw === 'string' ? raw : raw.toString())
    } catch {
      ws.send(JSON.stringify({ error: 'Invalid JSON' }))
      return
    }

    // Spawn
    if (msg.spawn) {
      if (ptyProcess) {
        ws.send(JSON.stringify({ error: 'Shell already spawned' }))
        return
      }

      const { cols, rows, cwd, useDevboxRc, env: envOverrides } = msg.spawn
      const workDir = cwd || getWorkspace()

      const shellArgs: string[] = []
      if (useDevboxRc) {
        const bashrcPath = getDevboxBashrcPath()
        if (existsSync(bashrcPath)) {
          shellArgs.push('--rcfile', bashrcPath)
        }
      }

      try {
        ptyProcess = ptySpawn('bash', shellArgs, {
          name: 'xterm-256color',
          cols: cols || 80,
          rows: rows || 24,
          cwd: workDir,
          env: buildSandboxChildEnv(process.env, envOverrides),
        })
      } catch (err: any) {
        ws.send(JSON.stringify({ error: `Failed to spawn shell: ${err.message}` }))
        ws.close()
        return
      }

      ptyProcess.onData((data: string) => {
        ws.send(JSON.stringify({ data: Buffer.from(data).toString('base64') }))
      })

      ptyProcess.onExit(({ exitCode }) => {
        ws.send(JSON.stringify({ exitCode }))
        ws.close()
      })

      return
    }

    if (!ptyProcess) {
      ws.send(JSON.stringify({ error: 'Shell not spawned yet — send spawn first' }))
      return
    }

    // Stdin data
    if (msg.data) {
      ptyProcess.write(Buffer.from(msg.data, 'base64').toString())
    }

    // Resize
    if (msg.resize) {
      ptyProcess.resize(msg.resize.cols, msg.resize.rows)
    }

    // Kill
    if (msg.kill) {
      ptyProcess.kill()
    }
  }

  // Attach handlers via ws.data pattern (Bun WebSocket)
  ;(ws as any)._shellHandler = onMessage
  ;(ws as any)._shellCleanup = cleanup
}
