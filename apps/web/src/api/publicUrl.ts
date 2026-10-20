import { apiFetch } from './client'

export type PublicAppUrlSource = 'environment' | 'setting' | 'local-default' | 'none'

/** Member-readable runtime address (GET /public-url); replaces the old build-time APP_URL. */
export interface PublicAppUrlRuntime {
  url: string | null
  localUrl: string | null
  source: PublicAppUrlSource
}

/** Administrator view of the server's public address (GET /public-url/status). */
export interface PublicAppUrlStatus {
  url?: string
  source: PublicAppUrlSource
  locked: boolean
  lockedBy?: 'environment' | 'managed'
  environmentUrl?: string
  environmentInvalid?: boolean
  storedUrl?: string
  localUrl?: string
  desktopManaged: boolean
  /** Send back with a change; a mismatch means someone else changed it first. */
  version: string
  lastChange: {
    previousValue: string | null
    newValue: string | null
    actor: string
    source: string
    at: string
  } | null
  mobileReady: boolean
  basePath: string
}

export interface UrlChange {
  label: string
  before: string | null
  after: string | null
}

export interface PublicAppUrlPreview {
  normalizedUrl: string | null
  effectiveUrl: string | null
  impact: {
    originChanged: boolean
    relayReconnectRequired: boolean
    mobileReady: boolean
    basePathMismatch: boolean
    oauthCallbacks: UrlChange[]
    webhooks: UrlChange[]
  }
}

export const getPublicAppUrl = () => apiFetch<PublicAppUrlRuntime>('/public-url')
export const getPublicAppUrlStatus = () => apiFetch<PublicAppUrlStatus>('/public-url/status')
export const previewPublicAppUrl = (url: string | null) =>
  apiFetch<PublicAppUrlPreview>('/public-url/preview', { method: 'POST', body: JSON.stringify({ url }) })
export const savePublicAppUrl = (input: { url: string | null; expectedVersion: string }) =>
  apiFetch<PublicAppUrlStatus>('/public-url', { method: 'PUT', body: JSON.stringify(input) })
