/**
 * "Send feedback to Ficus": product feedback a signed-in person sends from a
 * Ficus instance to the Ficus team. Not related to GitHub feedback moderation.
 */
export const PRODUCT_FEEDBACK_CATEGORIES = ['ai-response', 'bug', 'other'] as const
export type ProductFeedbackCategory = (typeof PRODUCT_FEEDBACK_CATEGORIES)[number]

export const PRODUCT_FEEDBACK_CATEGORY_LABELS: Record<ProductFeedbackCategory, string> = {
  'ai-response': 'AI response',
  bug: 'Bug',
  other: 'Something else',
}

/** Limits on the trimmed message, matching the Ficus platform's intake. */
export const PRODUCT_FEEDBACK_MESSAGE_MIN = 10
export const PRODUCT_FEEDBACK_MESSAGE_MAX = 6000
export const PRODUCT_FEEDBACK_PAGE_MAX = 512

/**
 * A route inside the instance (a pathname), never a full URL, query string or
 * fragment, so it cannot carry search terms, tokens or other data.
 */
export function isProductFeedbackPage(value: string): boolean {
  return (
    value.length <= PRODUCT_FEEDBACK_PAGE_MAX &&
    value.startsWith('/') &&
    !value.startsWith('//') &&
    !/[?#\s]/.test(value) &&
    !Array.from(value).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
  )
}

/** POST /api/product-feedback request body. */
export interface ProductFeedbackRequest {
  category: ProductFeedbackCategory
  message: string
  /** Attach the signed-in person's Core display name and email. */
  includeSubmitter: boolean
  /** The current route, when it is a valid instance pathname. */
  page?: string
}

/** GET /api/product-feedback/status. Never contains a credential. */
export interface ProductFeedbackStatus {
  /** False on a self-hosted instance that is not connected to a Ficus account. */
  connected: boolean
  /** Ficus Cloud instance (always connected). */
  managed: boolean
}

export type ProductFeedbackErrorCode = 'not_connected' | 'rate_limited' | 'unavailable'
