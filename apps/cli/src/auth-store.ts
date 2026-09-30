import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'fs'
import { homedir } from 'os'
import { dirname, join } from 'path'
import { expandTilde } from '@ficus/shared/node'
import { cliHome } from './local-server/home-move'

export interface AuthBackend {
  apiUrl: string
  password: string
  deviceId?: string
}

export interface AuthStore {
  active?: string
  backends: Record<string, AuthBackend>
}

function getDefaultAuthStorePath(): string {
  return join(cliHome({ homedir: homedir() }), 'cli', 'auth.json')
}

export function getAuthStorePath(): string {
  return expandTilde(process.env.FICUS_AUTH_STORE || getDefaultAuthStorePath())
}

export function emptyAuthStore(): AuthStore {
  return { backends: {} }
}

export function loadAuthStore(path = getAuthStorePath()): AuthStore {
  if (!existsSync(path)) return emptyAuthStore()

  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf-8'))
  } catch (error) {
    throw new Error(`Failed to read Ficus auth store at ${path}: ${(error as Error).message}`)
  }

  if (!parsed || typeof parsed !== 'object') throw new Error(`Invalid Ficus auth store at ${path}`)
  const raw = parsed as { active?: unknown; backends?: unknown }
  if (!raw.backends || typeof raw.backends !== 'object' || Array.isArray(raw.backends)) {
    throw new Error(`Invalid Ficus auth store at ${path}: missing backends object`)
  }

  const backends: Record<string, AuthBackend> = {}
  for (const [label, backend] of Object.entries(raw.backends)) {
    if (!backend || typeof backend !== 'object') throw new Error(`Invalid backend '${label}' in Ficus auth store`)
    const b = backend as { apiUrl?: unknown; password?: unknown; deviceId?: unknown }
    if (
      typeof b.apiUrl !== 'string' ||
      typeof b.password !== 'string' ||
      (b.deviceId !== undefined && typeof b.deviceId !== 'string')
    ) {
      throw new Error(`Invalid backend '${label}' in Ficus auth store`)
    }
    backends[label] = { apiUrl: b.apiUrl, password: b.password, ...(b.deviceId ? { deviceId: b.deviceId } : {}) }
  }

  const active = typeof raw.active === 'string' ? raw.active : undefined
  return { active, backends }
}

export function saveAuthStore(store: AuthStore, path = getAuthStorePath()): void {
  const dir = dirname(path)

  const isDefaultPath = path === getDefaultAuthStorePath()
  const dirExists = existsSync(dir)

  if (isDefaultPath) {
    const ficusDir = dirname(dir)
    mkdirSync(ficusDir, { recursive: true, mode: 0o700 })
    chmodSync(ficusDir, 0o700)
  }

  mkdirSync(dir, { recursive: true, mode: 0o700 })
  if (isDefaultPath || !dirExists) chmodSync(dir, 0o700)
  writeFileSync(path, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 })
  chmodSync(path, 0o600)
}

export function getActiveBackend(store = loadAuthStore()): { label: string; backend: AuthBackend } | undefined {
  if (!store.active) return undefined
  const backend = store.backends[store.active]
  if (!backend) return undefined
  return { label: store.active, backend }
}

export function redactBackend(label: string, backend: AuthBackend, active?: string) {
  return {
    label,
    apiUrl: backend.apiUrl,
    active: label === active,
    password: backend.password ? '<redacted>' : '',
  }
}
