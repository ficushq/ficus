import type { QueryClient } from '@tanstack/react-query'
import { lazy } from 'react'
import type { EntityReference } from '../lib/entityReference'

const loadReference = () => import('./EntityReferenceModal')

/** The in-place work stream / agent reference modal, code-split; render it inside a Suspense boundary. */
export const LazyEntityReferenceModal = lazy(() =>
  loadReference().then((module) => ({ default: module.EntityReferenceModal }))
)

/** Warm the modal's code and the reference's data. Speculative: opening still shows the retry/error UI. */
export function preloadEntityReferenceModal(client: QueryClient | undefined, reference: EntityReference) {
  void loadReference()
    .then((module) => client && module.preloadEntityReference(client, reference))
    .catch(() => {})
}
