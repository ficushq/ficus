// Hybrid shim: cross-platform auth comes from @ficus/client-core; browser-only WebAuthn
// ceremonies (which return @simplewebauthn/browser option types) stay here.
import type {
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/browser'
import { apiFetch } from './client'
import { client } from './clientInstance'
import type { AuthUser } from '@ficus/client-core'

export type { AuthStatus, AuthUser, AuthSettings, AuthValidation, PendingAdminAccount } from '@ficus/client-core'

// ── Cross-platform (shared client-core) ─────────────────────────────────────
export const getAuthStatus = client.auth.getAuthStatus
export const demoPair = client.auth.demoPair
export const loginWithPassword = client.auth.loginWithPassword
export const sendVerificationEmail = client.auth.sendVerificationEmail
export const getAuthSettings = client.auth.getAuthSettings
export const updateAuthSettings = client.auth.updateAuthSettings
export const validateAuth = client.auth.validateAuth
export const fetchWsTicket = client.auth.fetchWsTicket
export const getCurrentUser = client.auth.getCurrentUser
export const updateCurrentUser = client.auth.updateCurrentUser
export const getMyPermissions = client.auth.getMyPermissions

// ── Web-only WebAuthn ceremonies ────────────────────────────────────────────
export interface CredentialSummary {
  id: string
  credentialId: string
  displayName: string | null
  createdAt: string
}

export async function getRegistrationOptions(
  email: string,
  code: string,
  displayName?: string
): Promise<{ options: PublicKeyCredentialCreationOptionsJSON }> {
  return apiFetch('/auth/register/options', {
    method: 'POST',
    body: JSON.stringify({ email, code, displayName }),
  })
}

/**
 * `displayName` names the USER account; `credentialName` labels the passkey being
 * registered. Both are optional — a blank passkey name gets a device-derived
 * default from the server.
 */
export async function verifyRegistration(
  email: string,
  response: unknown,
  displayName?: string,
  credentialName?: string
): Promise<{ ok: boolean; token: string; user: AuthUser; firstAdmin?: boolean }> {
  return apiFetch('/auth/register/verify', {
    method: 'POST',
    body: JSON.stringify({ email, response, displayName, credentialName }),
  })
}

// ── Deep-link token registration (invites + passkey recovery) ───────────────
// The token authorises registering a passkey for the address it was issued to,
// once. It is not a session: only a completed ceremony logs you in.

export interface TokenRegistrationContext {
  options: PublicKeyCredentialCreationOptionsJSON
  email: string
  displayName: string | null
  purpose: 'register' | 'recovery'
}

export async function getTokenRegistrationOptions(token: string): Promise<TokenRegistrationContext> {
  return apiFetch('/auth/register/token/options', {
    method: 'POST',
    body: JSON.stringify({ token }),
  })
}

/**
 * `displayName` is only meaningful for an INVITE — a recovery ceremony runs against
 * an account that already exists, so its form omits the field and the server
 * ignores it. `credentialName` labels the new passkey in both cases.
 */
export async function verifyTokenRegistration(
  token: string,
  response: unknown,
  displayName?: string,
  credentialName?: string
): Promise<{ ok: boolean; token: string; user: AuthUser; firstAdmin?: boolean }> {
  return apiFetch('/auth/register/token/verify', {
    method: 'POST',
    body: JSON.stringify({ token, response, displayName, credentialName }),
  })
}

/**
 * Ask for a passkey-recovery link. Always resolves to { ok: true } — the server
 * answers identically for registered and unregistered addresses on purpose, so
 * the UI must never phrase the result as confirmation that an account exists.
 */
export async function requestPasskeyRecovery(email: string): Promise<{ ok: boolean }> {
  return apiFetch('/auth/recover/passkey', {
    method: 'POST',
    body: JSON.stringify({ email }),
  })
}

export async function getLoginOptions(
  email?: string
): Promise<{ options: PublicKeyCredentialRequestOptionsJSON; challengeKey: string }> {
  return apiFetch('/auth/login/options', {
    method: 'POST',
    body: JSON.stringify({ email }),
  })
}

export async function verifyLogin(
  challengeKey: string,
  response: unknown
): Promise<{ ok: boolean; token: string; user: AuthUser }> {
  return apiFetch('/auth/login/verify', {
    method: 'POST',
    body: JSON.stringify({ challengeKey, response }),
  })
}

export async function listMyCredentials(): Promise<CredentialSummary[]> {
  return apiFetch('/auth/me/credentials')
}

export async function deleteMyCredential(id: string): Promise<void> {
  return apiFetch(`/auth/me/credentials/${id}`, { method: 'DELETE' })
}

/** Rename one of my passkeys. Owner-scoped server-side: another user's id answers 404. */
export async function renameMyCredential(id: string, displayName: string): Promise<CredentialSummary> {
  return apiFetch(`/auth/me/credentials/${id}`, {
    method: 'PATCH',
    body: JSON.stringify({ displayName }),
  })
}

export async function addCredentialOptions(): Promise<{ options: PublicKeyCredentialCreationOptionsJSON }> {
  return apiFetch('/auth/me/credentials/options', { method: 'POST' })
}

export async function addCredentialVerify(response: unknown, displayName?: string): Promise<{ ok: boolean }> {
  return apiFetch('/auth/me/credentials/verify', {
    method: 'POST',
    body: JSON.stringify({ response, displayName }),
  })
}

export interface FeedVisit {
  lastVisitedAt: string | null
  observedAt: string
}

export function getFeedVisit(): Promise<FeedVisit> {
  return apiFetch('/auth/me/feed-visit')
}

export function acknowledgeFeedVisit(visitedAt: string): Promise<{ lastVisitedAt: string }> {
  return apiFetch('/auth/me/feed-visit', { method: 'POST', body: JSON.stringify({ visitedAt }) })
}
