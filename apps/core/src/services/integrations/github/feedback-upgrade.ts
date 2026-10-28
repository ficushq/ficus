import { sql } from 'drizzle-orm'
import { gitHubFreshnessBindingSQL } from './feedback-freshness-binding'
import { inbox } from '../../../db'
import { eventAuthoritySquadId, inboxIntegrationEventId, inboxRecipientAgentId } from './feedback-pass-read'

/**
 * Pure inbox fence: ON keeps unaccepted GitHub prose behind final admission. In every mode,
 * unbound legacy prose lacks native freshness provenance and cannot be restored by toggling OFF.
 * No guessed rebinding, body rewrite, replay or author lookup. Delivered history/receipts, other
 * providers and server-owned content-free status projections remain unchanged.
 * A receipt exception also binds its actual accepted inbox message, not a caller-chosen client ID.
 * Preparation/renewal records github_freshness_unbound on the source audit; reads themselves do not mutate rows.
 */
export function withheldGitHubInboxCondition() {
  return sql`(${inbox.recipientType} = 'agent' AND ${inbox.deliveredAt} IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM chat_send_receipts accepted_receipt
      INNER JOIN messages accepted_message ON accepted_message.id = accepted_receipt.message_id
        AND accepted_message.agent_id = accepted_receipt.agent_id
      WHERE accepted_receipt.agent_id = ${inboxRecipientAgentId()}
        AND accepted_receipt.state = 'accepted'
        AND accepted_receipt.message_id IS NOT NULL AND accepted_receipt.execution_id IS NOT NULL
        AND accepted_receipt.accepted_at IS NOT NULL
        AND accepted_message.role = 'human'
        AND accepted_message.metadata->>'source' = 'inbox'
        AND accepted_message.metadata->>'clientId' = accepted_receipt.client_id
        AND accepted_message.metadata->>'executionId' = accepted_receipt.execution_id::text
        AND accepted_message.metadata->'inboxMessageIds' @> jsonb_build_array(${inbox.id}::text)
        AND (accepted_receipt.client_id = 'github-feedback:' || (${inboxIntegrationEventId()})::text || ':' || ${inbox.id}::text
          OR accepted_receipt.client_id = 'integration-output:' || (${inbox.metadata}->>'integrationDeliveryId') || ':' || ${inbox.id}::text)
    ) AND EXISTS (
    SELECT 1 FROM integration_output_events fenced_event
    WHERE fenced_event.id = ${inboxIntegrationEventId()}
      AND fenced_event.integration = 'github'
      AND fenced_event.source_key NOT LIKE 'github-status:%'
      AND (NOT ${gitHubFreshnessBindingSQL(sql`fenced_event.fact`, sql`fenced_event.source_key`)} OR COALESCE(
        (SELECT fenced_squad.github_author_filter FROM squads fenced_squad
          WHERE fenced_squad.id = ${eventAuthoritySquadId('fenced_event')}),
        true
      ))
  ))`
}

/** Agent-facing inbox reads: everything except fenced GitHub mail. */
export function visibleInboxCondition() {
  return sql`NOT ${withheldGitHubInboxCondition()}`
}
