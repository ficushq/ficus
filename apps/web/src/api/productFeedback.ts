import type { ProductFeedbackRequest, ProductFeedbackStatus } from '@ficus/shared'
import { apiFetch } from './client'

/** "Send feedback to Ficus". Unrelated to GitHub feedback moderation (githubFeedback.ts). */
export const getProductFeedbackStatus = () => apiFetch<ProductFeedbackStatus>('/product-feedback/status')

/** Core forwards the report to Ficus with this instance's own credential; the browser never holds it. */
export const sendProductFeedback = (body: ProductFeedbackRequest) =>
  apiFetch<{ id: string }>('/product-feedback', { method: 'POST', body: JSON.stringify(body) })
