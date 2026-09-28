import { isUserAssistantAgentType } from '@ficus/shared'
import { existsSync, readFileSync } from 'fs'
import { createPublicKey } from 'crypto'
import type { AmtpSigningIdentity, AmtpSigningIdentityReason } from '@ficus/shared'
import type { Agent } from '../../entities/Agent'
import { agentIdentityHostPath, publicPemFromPrivate, samePublicKey } from './agent-identity'

const MESSAGES: Record<AmtpSigningIdentityReason, string> = {
  shared_system_manager_custody:
    'System-manager federation is unsupported because the sandbox private root is shared; use a dedicated non-shared agent.',
  shared_consultant_custody:
    'Consultant federation is unsupported because squad consultant chats share a sandbox; use a dedicated agent.',
  shared_parent_custody:
    'Subagent federation is unsupported because the sandbox private root is shared with its parent; use a dedicated non-shared agent.',
  missing_public_key: 'Federation signing identity is not provisioned; start/retry the agent sandbox, then try again.',
  invalid_public_key: 'The recorded federation signing identity is invalid. Contact an operator.',
  missing_private_key:
    'Federation signing identity private key is missing; automatic rotation is disabled. Contact an operator.',
  invalid_private_key:
    'Federation signing identity private key is invalid; automatic rotation is disabled. Contact an operator.',
  public_private_mismatch:
    'Federation signing identity does not match recorded identity; automatic rotation is disabled. Contact an operator.',
}

function failed(status: 'unavailable' | 'unsupported', reason: AmtpSigningIdentityReason): AmtpSigningIdentity {
  return { status, reason, message: MESSAGES[reason], identityPublicKey: null }
}

/** Read-only inspection of whether Core has unique, matching signing custody. */
export async function inspectAgentSigningIdentity(agent: Agent): Promise<AmtpSigningIdentity> {
  if (isUserAssistantAgentType(agent.agentTypeId)) return failed('unsupported', 'shared_system_manager_custody')
  if (agent.parentAgentId) return failed('unsupported', 'shared_parent_custody')
  if (agent.agentTypeId === 'consultant' && agent.squadId) return failed('unsupported', 'shared_consultant_custody')
  if (!agent.identityPublicKey) return failed('unavailable', 'missing_public_key')

  try {
    const publicKey = createPublicKey(agent.identityPublicKey)
    if (publicKey.asymmetricKeyType !== 'ed25519') return failed('unavailable', 'invalid_public_key')
  } catch {
    return failed('unavailable', 'invalid_public_key')
  }

  const path = agentIdentityHostPath(await agent.getSandboxId())
  if (!existsSync(path)) return failed('unavailable', 'missing_private_key')

  let derived: string
  try {
    derived = publicPemFromPrivate(readFileSync(path, 'utf-8'))
  } catch {
    return failed('unavailable', 'invalid_private_key')
  }
  try {
    if (!samePublicKey(agent.identityPublicKey, derived)) return failed('unavailable', 'public_private_mismatch')
  } catch {
    return failed('unavailable', 'invalid_public_key')
  }

  return { status: 'ready', reason: null, message: null, identityPublicKey: agent.identityPublicKey }
}
