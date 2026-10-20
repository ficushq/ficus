/**
 * One eligibility refresh: read the installed host record, probe the local helper, ask Platform
 * for its support report, and record the three together (availability decides whether they
 * agree). A transient failure (busy helper, unreachable Platform) keeps the last snapshot.
 */
import { isPlatformManaged } from '../../../secrets/managed'
import { noteManagedBigbrainCapabilityFailure, recordManagedBigbrainSupport } from './availability'
import { createManagedHostClient, type ManagedHostClient } from './host-client'
import { readInstalledHost } from './host-identity'
import { managedBigbrainPlatform } from './platform-client'

export interface ManagedRefreshDeps {
  hostClient?: Pick<ManagedHostClient, 'call'>
  platform?: Pick<typeof managedBigbrainPlatform, 'support'>
  readHost?: typeof readInstalledHost
  now?: () => number
}
let defaultClient: ManagedHostClient | null = null

export async function refreshManagedBigbrainSupport(deps: ManagedRefreshDeps = {}): Promise<void> {
  if (!isPlatformManaged()) return
  try {
    const host = await (deps.readHost ?? readInstalledHost)()
    const client = deps.hostClient ?? (defaultClient ??= createManagedHostClient())
    const probe = await client.call(host, crypto.randomUUID(), { action: 'probe' })
    if (!('capabilities' in probe)) throw Object.assign(new Error('invalid_response'), { code: 'invalid_response' })
    const platform = await (deps.platform ?? managedBigbrainPlatform).support({ expectedTenantId: host.tenantId })
    recordManagedBigbrainSupport({ local: probe.capabilities, platform, host }, (deps.now ?? Date.now)())
  } catch (error) {
    noteManagedBigbrainCapabilityFailure(error)
  }
}
