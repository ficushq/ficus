import { SessionManager } from '@earendil-works/pi-coding-agent'
import { existsSync, readdirSync, mkdirSync } from 'fs'
import { join } from 'path'
import { getHomeDir } from '../utils/home'

export function getSessionDir(agentId: string): string {
  return join(getHomeDir(), 'sessions', agentId)
}

export function findSessionFile(dir: string): string | null {
  if (!existsSync(dir)) return null
  const files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'))
  if (files.length === 0) return null
  // Files are timestamp-prefixed, sort to get latest
  files.sort()
  return join(dir, files[files.length - 1])
}

export function openOrCreateSession(agentId: string, _cwd?: string): SessionManager {
  const sessionDir = getSessionDir(agentId)
  // CWD is just symbolic since we control the sessions completely, so the
  // session directory is used as the CWD and the caller's CWD is ignored.
  // continueRecent finds the most recent (only) session file in the directory,
  // and if it exists, opens it (but uses the session directory as CWD), otherwise creates a
  // new session.
  return SessionManager.continueRecent(sessionDir, sessionDir)
}

export function ensureSessionDataDir(): void {
  mkdirSync(getSessionDir(''), { recursive: true })
}
