import { timingSafeEqual } from 'node:crypto'
import type { IncomingHttpHeaders } from 'node:http'

export const DEV_ACCESS_COOKIE = 'ficus_dev_access'
export const DEV_ACCESS_HEADER = 'x-tau-dev-access-token'

function tokensMatch(candidate: string | undefined, expected: string): boolean {
  if (!candidate) return false
  const candidateBuffer = Buffer.from(candidate)
  const expectedBuffer = Buffer.from(expected)
  return candidateBuffer.length === expectedBuffer.length && timingSafeEqual(candidateBuffer, expectedBuffer)
}

function cookieValue(cookieHeader: string | undefined, name: string): string | undefined {
  for (const part of cookieHeader?.split(';') ?? []) {
    const separator = part.indexOf('=')
    if (separator === -1 || part.slice(0, separator).trim() !== name) continue
    try {
      return decodeURIComponent(part.slice(separator + 1).trim())
    } catch {
      return undefined
    }
  }
}

export function requestHasDevAccess(headers: IncomingHttpHeaders, expectedToken: string): boolean {
  const header = headers[DEV_ACCESS_HEADER]
  const headerToken = Array.isArray(header) ? header[0] : header
  return (
    tokensMatch(headerToken, expectedToken) ||
    tokensMatch(cookieValue(headers.cookie, DEV_ACCESS_COOKIE), expectedToken)
  )
}

export function stripDevAccessCookie(cookieHeader: string | undefined): string | undefined {
  const remaining = (cookieHeader?.split(';') ?? []).filter((part) => {
    const separator = part.indexOf('=')
    return separator === -1 || part.slice(0, separator).trim() !== DEV_ACCESS_COOKIE
  })
  return remaining.length > 0 ? remaining.join(';') : undefined
}
