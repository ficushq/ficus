import { Squad } from '../../../entities/Squad'
import { InboxMessage } from '../../../entities/InboxMessage'
import { deliverInboxMessagesToAgent } from '../../inbox/inboxDelivery'
import { createLogger } from '../../../lib/infra/logger'
import { ToolchainProvisioningError } from './provision'
import type { ToolchainErrorCode } from './state'

const log = createLogger('toolchain')

export interface ToolchainFailureNoticeInput {
  sandboxId: string
  squadId: string
  desiredFingerprint: string
  errorCode: ToolchainErrorCode
}

export interface ToolchainFailureNoticeDeps {
  findManagerAgentId(squadId: string): Promise<string | null>
  sendOnce: typeof InboxMessage.sendOnce
  deliver(agentId: string): Promise<void>
}

const defaultDeps: ToolchainFailureNoticeDeps = {
  findManagerAgentId: async (squadId) => (await Squad.find(squadId))?.managerAgentId ?? null,
  sendOnce: (input, key) => InboxMessage.sendOnce(input, key),
  deliver: deliverInboxMessagesToAgent,
}

/** One notice per squad and toolchain declaration, whichever sandbox failed first. */
export function toolchainFailureNoticeKey(input: Pick<ToolchainFailureNoticeInput, 'squadId' | 'desiredFingerprint'>) {
  return `toolchain-failed:${input.squadId}:${input.desiredFingerprint}`
}

export function renderToolchainFailureNotice(input: ToolchainFailureNoticeInput): string {
  const reason = new ToolchainProvisioningError(input.errorCode).message
  return [
    `The managed toolchain for this squad failed to install on sandbox ${input.sandboxId}: ${reason} (${input.errorCode}).`,
    '',
    'Boxes that already had an activated toolchain keep running with it, so agents keep working, but tools added by this change (for example a newly attached integration CLI) are not available. Boxes with no previous toolchain cannot start agent work until the install succeeds.',
    '',
    `Check \`ficus squad sandbox-status ${input.squadId}\` for the failure, fix its cause (the squad's toolchain declaration or setup script, or the integration that contributed the failing step), then run \`ficus squad toolchain apply ${input.squadId}\`. This notice is sent once per toolchain declaration.`,
  ].join('\n')
}

/** Tell the squad manager, once per declaration, that a toolchain install failed. */
export async function notifyToolchainFailure(
  input: ToolchainFailureNoticeInput,
  deps: ToolchainFailureNoticeDeps = defaultDeps
): Promise<void> {
  const managerAgentId = await deps.findManagerAgentId(input.squadId)
  if (!managerAgentId) {
    log.warn(`Toolchain for squad ${input.squadId} failed on ${input.sandboxId}, and the squad has no manager to tell`)
    return
  }
  const { created } = await deps.sendOnce(
    {
      recipientType: 'agent',
      recipientId: managerAgentId,
      senderType: 'system',
      deliveryMode: 'follow-up',
      wakeEligible: true,
      subject: 'Sandbox toolchain install failed',
      content: renderToolchainFailureNotice(input),
      metadata: {
        source: 'toolchain',
        squadId: input.squadId,
        sandboxId: input.sandboxId,
        errorCode: input.errorCode,
      },
    },
    toolchainFailureNoticeKey(input)
  )
  if (created) await deps.deliver(managerAgentId)
}
