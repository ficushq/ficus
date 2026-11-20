import { DbIntegrationConnectionRepository } from '../db-connection-repository'
import { sendOAuthControlPlaneAlert } from '../authorization/oauth-operational-alert'
import { findLinearAppConnectionRow } from './app-ingress'

/**
 * `OAuthApp` `revoked`: the app was uninstalled from the workspace. Every app connection for it needs
 * reauthorization (which stops Ficus writing to its sessions and, with the hosted relay, its
 * subscription), and operators get the OAuth operational alert.
 */
export async function handleLinearAppRevoked(organizationId: string) {
  const repository = new DbIntegrationConnectionRepository()
  for (const connection of await findLinearAppConnectionRow(organizationId)) {
    const updated = await repository.markReauthorizationRequired({
      id: connection.id,
      materialRevision: connection.materialRevision,
      code: 'app_uninstalled',
    })
    if (!updated) continue
    await sendOAuthControlPlaneAlert({
      connectionId: connection.id,
      providerKey: 'linear',
      materialRevision: connection.materialRevision,
      safeCode: 'app_uninstalled',
    })
  }
}
