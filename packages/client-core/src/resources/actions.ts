import type { PendingAction, PendingActionType } from '@ficus/shared'
import type { Transport } from '../transport'

export interface ListPendingActionsOptions {
  /** Only these action types. Omitted (or empty) lists every type, including `workstream-delivery`. */
  types?: readonly PendingActionType[]
}

export function actionsResource(t: Transport) {
  return {
    /**
     * Everything pending for the caller. Lists every action type unless `types` narrows it, so a
     * client must render types it does not know (for example with a generic fallback).
     */
    listPendingActions: (options: ListPendingActionsOptions = {}): Promise<PendingAction[]> =>
      t.request(options.types?.length ? `/actions/pending?types=${options.types.join(',')}` : '/actions/pending'),
  }
}
