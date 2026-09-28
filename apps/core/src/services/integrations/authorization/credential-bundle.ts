import type { OAuthClientBinding } from '@ficus/shared/oauth-providers/types'

export interface OAuthCredentialBundleV1 {
  version: 1
  accessToken: string
  refreshToken: string | null
  expiresAt: string | null
  tokenRevision: number
  clientBinding?: OAuthClientBinding
}

export interface OAuthCredentialRotation {
  accessToken: string
  refreshToken: string | null
  expiresAt: string | null
}

const CREDENTIAL_KEYS = ['accessToken', 'expiresAt', 'refreshToken', 'tokenRevision', 'version']
const MAX_TOKEN_LENGTH = 16_384
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

export function parseOAuthCredential(raw: unknown): OAuthCredentialBundleV1 {
  try {
    if (typeof raw !== 'string' || raw.length > MAX_TOKEN_LENGTH * 2 + 1_024) throw new Error()
    return validate(JSON.parse(raw))
  } catch {
    throw new Error('Invalid OAuth credential bundle')
  }
}

export function serializeOAuthCredential(value: OAuthCredentialBundleV1): string {
  const credential = validate(value)
  return JSON.stringify({
    version: credential.version,
    accessToken: credential.accessToken,
    refreshToken: credential.refreshToken,
    expiresAt: credential.expiresAt,
    tokenRevision: credential.tokenRevision,
    ...(credential.clientBinding ? { clientBinding: credential.clientBinding } : {}),
  })
}

export function rotateOAuthCredential(
  current: OAuthCredentialBundleV1,
  rotation: OAuthCredentialRotation
): OAuthCredentialBundleV1 {
  const revision = current.tokenRevision + 1
  if (!Number.isSafeInteger(revision)) throw new Error('OAuth credential revision exhausted')
  return validate({
    version: 1,
    ...rotation,
    tokenRevision: revision,
    ...(current.clientBinding ? { clientBinding: current.clientBinding } : {}),
  })
}

function validate(value: unknown): OAuthCredentialBundleV1 {
  if (
    !isRecord(value) ||
    Object.keys(value)
      .filter((key) => key !== 'clientBinding')
      .sort()
      .join() !== CREDENTIAL_KEYS.join()
  )
    throw new Error()
  const clientBinding = value.clientBinding === undefined ? undefined : parseOAuthClientBinding(value.clientBinding)
  if (value.version !== 1) throw new Error()
  if (!isToken(value.accessToken)) throw new Error()
  if (value.refreshToken !== null && !isToken(value.refreshToken)) throw new Error()
  if (value.expiresAt !== null && !isIsoInstant(value.expiresAt)) throw new Error()
  if (!Number.isSafeInteger(value.tokenRevision) || (value.tokenRevision as number) < 1) throw new Error()
  return {
    version: 1,
    accessToken: value.accessToken,
    refreshToken: value.refreshToken,
    expiresAt: value.expiresAt,
    tokenRevision: value.tokenRevision as number,
    ...(clientBinding ? { clientBinding } : {}),
  }
}

export function parseOAuthClientBinding(value: unknown): OAuthClientBinding {
  if (
    !isRecord(value) ||
    Object.keys(value).some((key) => !['clientId', 'credentialRef'].includes(key)) ||
    typeof value.clientId !== 'string' ||
    !/^[a-zA-Z0-9._-]{1,512}$/.test(value.clientId) ||
    (value.credentialRef !== undefined &&
      (typeof value.credentialRef !== 'string' ||
        !/^__integration-oauth-app:github:client:[a-f0-9-]{36}$/.test(value.credentialRef)))
  )
    throw new Error('Invalid OAuth client binding')
  return {
    clientId: value.clientId,
    ...(typeof value.credentialRef === 'string' ? { credentialRef: value.credentialRef } : {}),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function isToken(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= MAX_TOKEN_LENGTH
}

function isIsoInstant(value: unknown): value is string {
  return typeof value === 'string' && ISO_INSTANT.test(value) && new Date(value).toISOString() === value
}
