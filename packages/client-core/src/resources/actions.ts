import type { PendingAction } from '@ficus/shared'
import type { Transport } from '../transport'

export function actionsResource(t: Transport) {
  return {
    listPendingActions: (): Promise<PendingAction[]> => t.request('/actions/pending'),
  }
}
