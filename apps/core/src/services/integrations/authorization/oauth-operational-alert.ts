import { SYSTEM_RECIPIENT_ID } from '@ficus/shared'
import { InboxMessage } from '../../../entities/InboxMessage'

export type OAuthControlPlaneAlertCode =
  | 'broker_unauthorized'
  | 'insufficient_scope'
  | 'client_authority_mismatch'
  /** The provider reported the app uninstalled from the workspace (Linear `OAuthApp` `revoked`). */
  | 'app_uninstalled'

export interface OAuthControlPlaneAlert {
  connectionId: string
  providerKey: string
  materialRevision: string
  safeCode: OAuthControlPlaneAlertCode
}

type SendOnce = typeof InboxMessage.sendOnce

/** Emit one durable, sanitized operator alert for a denied broker control-plane request. */
export async function sendOAuthControlPlaneAlert(
  alert: OAuthControlPlaneAlert,
  sendOnce: SendOnce = InboxMessage.sendOnce
): Promise<void> {
  await sendOnce(
    {
      recipientType: 'system',
      recipientId: SYSTEM_RECIPIENT_ID,
      senderType: 'system',
      wakeEligible: false,
      subject:
        alert.safeCode === 'app_uninstalled'
          ? 'OAuth app was uninstalled and requires attention'
          : 'OAuth control plane access requires attention',
      content:
        alert.safeCode === 'app_uninstalled'
          ? `The ${alert.providerKey} app was uninstalled from its workspace. The connection needs reauthorization; install the app again to restore it.`
          : alert.safeCode === 'client_authority_mismatch'
            ? `OAuth authority changed for provider ${alert.providerKey}. Reauthorize the connection before retrying.`
            : `Hosted OAuth control-plane access was denied for provider ${alert.providerKey}. Check the managed instance authorization before retrying.`,
      metadata: {
        source: 'integration-oauth-control-plane',
        connectionId: alert.connectionId,
        providerKey: alert.providerKey,
        materialRevision: alert.materialRevision,
        safeCode: alert.safeCode,
        occurrenceClass:
          alert.safeCode === 'app_uninstalled'
            ? 'app_uninstalled'
            : alert.safeCode === 'client_authority_mismatch'
              ? 'client_authority_mismatch'
              : 'broker_access_denied',
      },
    },
    `integration-oauth-control-plane:v1:${alert.connectionId}:${alert.materialRevision}:${alert.safeCode}`
  )
}
