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
    /** The base path the web app and documentation will be served under ('' at the root). */
    basePath: string
    basePathChanged: boolean
    /** False when the path is also a Ficus page or API prefix: only a proxy that removes it works. */
    basePathStrippable: boolean
    /** False when the path cannot be used for squad apps (characters a cookie path cannot carry). */
    localAppsUnderBasePath: boolean
    /** Running managed squad apps that restart so their links use the new path. */
    localAppsAffected: number
    /** Running apps started outside Ficus that must be restarted by hand. */
    externalAppsAffected: number
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

/** Where an address can be opened from, judged from the address alone (see @ficus/shared classifyServerAddress). */
export type ServerAddressReach = 'none' | 'this-computer' | 'home-network' | 'tailscale' | 'public'

/** What this machine could offer a mobile device (GET /api/public-url/reach). */
export interface PhoneReachReport {
  current: { url: string | null; reach: ServerAddressReach; https: boolean }
  /** `desktopManaged`: Ficus Desktop started this server and decides what it listens on. */
  listening: { host: string; port: number; beyondThisComputer: boolean; desktopManaged: boolean }
  homeNetwork: { addresses: string[] }
  tailscale: {
    state: 'not-installed' | 'stopped' | 'running'
    /** The Tailscale tool found: on PATH, only inside the macOS app, or none. */
    cli: 'path' | 'app' | null
    address?: string
    serveCommand: string
  }
}

export type AddressCheckResult =
  { ok: true } | { ok: false; reason: 'invalid' | 'unreachable' | 'timeout' | 'certificate' | 'not-this-server' }

export const getPhoneReach = () => apiFetch<PhoneReachReport>('/public-url/reach')
export const checkPublicAddress = (url: string) =>
  apiFetch<AddressCheckResult>('/public-url/check', { method: 'POST', body: JSON.stringify({ url }) })
