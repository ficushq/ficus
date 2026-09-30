import type { PendingAction } from '@ficus/shared'
import type { Transport } from '../transport'

export function actionsResource(t: Transport) {
  return {
    /**
     * `include: ['workstream-delivery']` opts into view-only code-host delivery
     * gates; only request it from a client that renders that action type.
     */
    listPendingActions: (options: { include?: Array<'workstream-delivery'> } = {}): Promise<PendingAction[]> =>
      t.request(options.include?.length ? `/actions/pending?include=${options.include.join(',')}` : '/actions/pending'),
  }
}
