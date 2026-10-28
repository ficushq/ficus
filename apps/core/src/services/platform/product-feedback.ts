import { z } from 'zod'
import type { ProductFeedbackCategory, ProductFeedbackErrorCode, ProductFeedbackStatus } from '@ficus/shared'
import corePackage from '../../../package.json'
import { requireBrokerConfig } from '../integrations/authorization/authority'
import { pushRelayConfig } from '../push/relay'
import { isPlatformManaged } from '../secrets/managed'

/**
 * "Send feedback to Ficus": forwards a product feedback report to the Ficus
 * platform's POST /api/instance-feedback with the instance credential Core
 * already holds. The platform attributes the report to the instance owner's
 * Ficus account from that credential alone.
 *
 * The credential never leaves this module: it is not returned, logged, or put
 * in an error. Platform response bodies are never surfaced either; every
 * failure becomes one of the fixed ProductFeedbackError codes.
 */

const MESSAGES: Record<ProductFeedbackErrorCode, string> = {
  not_connected: 'Connect this server to a Ficus account to send feedback.',
  rate_limited: 'Too much feedback has been sent from this server recently. Try again in an hour.',
  unavailable: 'Feedback could not be sent right now. Try again later.',
}

const STATUS: Record<ProductFeedbackErrorCode, 409 | 429 | 503> = {
  not_connected: 409,
  rate_limited: 429,
  unavailable: 503,
}

export class ProductFeedbackError extends Error {
  readonly status: 409 | 429 | 503
  constructor(readonly code: ProductFeedbackErrorCode) {
    super(MESSAGES[code])
    this.name = 'ProductFeedbackError'
    this.status = STATUS[code]
  }
}

export interface ProductFeedbackReport {
  category: ProductFeedbackCategory
  message: string
  /** Omitted when the person opted out; the report is then attributed only to the owner account. */
  submitter?: { name?: string; email?: string }
  page?: string
}

interface FeedbackCredential {
  managed: boolean
  baseUrl: string
  token: string
}

interface ProductFeedbackDependencies {
  managed: () => boolean
  /** Ficus Cloud tenant credential (FICUS_PLATFORM_BASE_URL + FICUS_PLATFORM_INSTANCE_TOKEN). */
  cloudConfig: () => { baseUrl: string; token: string }
  /** Self-hosted "Connect Ficus account" credential, or null when not connected. */
  relayConfig: () => { baseUrl: string; token: string } | null
  fetch: (url: string, init: RequestInit) => Promise<Response>
  coreVersion: string
}

const defaults: ProductFeedbackDependencies = {
  managed: isPlatformManaged,
  cloudConfig: requireBrokerConfig,
  relayConfig: pushRelayConfig,
  fetch: (url, init) => fetch(url, init),
  coreVersion: corePackage.version,
}

const createdSchema = z.object({ id: z.uuid() })

/** https (or http on loopback, for local development) without credentials, query or fragment. */
function intakeUrl(baseUrl: string): string | null {
  let base: URL
  try {
    base = new URL(baseUrl)
  } catch {
    return null
  }
  if (base.username || base.password || base.search || base.hash) return null
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)
  if (base.protocol !== 'https:' && !(base.protocol === 'http:' && loopback)) return null
  return `${base.toString().replace(/\/+$/, '')}/api/instance-feedback`
}

export class ProductFeedbackService {
  constructor(private deps: ProductFeedbackDependencies = defaults) {}

  /**
   * Ficus Cloud always uses its tenant credential. A self-hosted instance uses
   * its "Connect Ficus account" credential and is not connected without one.
   */
  private credential(): FeedbackCredential | null {
    if (this.deps.managed()) {
      try {
        return { managed: true, ...this.deps.cloudConfig() }
      } catch {
        throw new ProductFeedbackError('unavailable')
      }
    }
    try {
      const config = this.deps.relayConfig()
      return config ? { managed: false, baseUrl: config.baseUrl, token: config.token } : null
    } catch {
      // A malformed stored credential cannot authenticate; treat it like no connection.
      return null
    }
  }

  /** Local check only: no platform request, no credential in the result. */
  status(): ProductFeedbackStatus {
    const managed = this.deps.managed()
    if (managed) return { connected: true, managed }
    return { connected: this.credential() !== null, managed }
  }

  async send(report: ProductFeedbackReport): Promise<{ id: string }> {
    const credential = this.credential()
    if (!credential) throw new ProductFeedbackError('not_connected')
    const url = intakeUrl(credential.baseUrl)
    if (!url) throw new ProductFeedbackError('unavailable')
    const body = {
      category: report.category,
      message: report.message,
      ...(report.submitter && Object.keys(report.submitter).length > 0 ? { submitter: report.submitter } : {}),
      context: { coreVersion: this.deps.coreVersion, ...(report.page ? { page: report.page } : {}) },
    }

    let response: Response
    try {
      response = await this.deps.fetch(url, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(15_000),
        headers: { Authorization: `Bearer ${credential.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
    } catch {
      // Fetch errors can describe the request; never surface or log them.
      throw new ProductFeedbackError('unavailable')
    }

    if (response.status !== 201) {
      await response.body?.cancel().catch(() => {})
      if (response.status === 429) throw new ProductFeedbackError('rate_limited')
      // On self-hosted, 401 means the connection expired or was revoked. A Cloud
      // tenant cannot reconnect itself, so there it is an outage like any other.
      if (response.status === 401 && !credential.managed) throw new ProductFeedbackError('not_connected')
      throw new ProductFeedbackError('unavailable')
    }
    let decoded: unknown
    try {
      decoded = await response.json()
    } catch {
      throw new ProductFeedbackError('unavailable')
    }
    const created = createdSchema.safeParse(decoded)
    if (!created.success) throw new ProductFeedbackError('unavailable')
    return { id: created.data.id }
  }
}

export const productFeedbackService = new ProductFeedbackService()
