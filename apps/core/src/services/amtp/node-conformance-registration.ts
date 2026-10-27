import { openNodeConformanceDb } from './node-conformance-sqlite'

export interface RawNodeRegistration {
  handle: string
  inbound_open: number
  agent_public_key_pem: string
}

export interface ExpectedNodeRegistration {
  handle: string
  agentPublicKeyPem: string
  inboundOpen: boolean
}

interface EstablishOpenNodeMailboxDependencies<TRegistration extends ExpectedNodeRegistration> {
  now: () => number
  operationId: () => string
  runRegister: (options: { operationId: string; timeoutMs: number }) => Promise<TRegistration>
  inspectRegistration: () => RawNodeRegistration | null
  waitForServerKey: (options: { registration: ExpectedNodeRegistration; timeoutMs: number }) => Promise<void>
}

/**
 * Audits the CLI result against SQLite and the already-running server within
 * the CLI's original deadline. These visibility checks are defense in depth;
 * exact executable/entrypoint ownership addresses the observed zero-output
 * child startup stall before any registration phase was reached.
 */
export async function establishNodeMailbox<TRegistration extends ExpectedNodeRegistration>(
  requested: { handle: string; inboundOpen: boolean },
  timeoutMs: number,
  dependencies: EstablishOpenNodeMailboxDependencies<TRegistration>
): Promise<TRegistration> {
  const deadline = dependencies.now() + timeoutMs
  const remainingMs = (nextStage: string) => {
    const remaining = deadline - dependencies.now()
    if (remaining <= 0) {
      throw new Error(`node-mailbox-ready budget exhausted before ${nextStage}`)
    }
    return remaining
  }
  const registered = await dependencies.runRegister({
    operationId: dependencies.operationId(),
    timeoutMs: remainingMs('registration'),
  })
  assertRequestedRegistration(registered, requested)
  remainingMs('sqlite audit')
  assertNodeRegistration(dependencies.inspectRegistration(), registered)
  await dependencies.waitForServerKey({
    registration: registered,
    timeoutMs: remainingMs('server visibility'),
  })
  return registered
}

function assertRequestedRegistration(
  actual: ExpectedNodeRegistration,
  requested: { handle: string; inboundOpen: boolean }
): void {
  const handleMatches = actual.handle === requested.handle
  const inboundOpenMatches = actual.inboundOpen === requested.inboundOpen
  if (!handleMatches || !inboundOpenMatches || actual.agentPublicKeyPem.length === 0) {
    throw new Error(
      `node-register-result failed: handleMatches=${handleMatches} ` +
        `publicKeyPresent=${actual.agentPublicKeyPem.length > 0} inboundOpenMatches=${inboundOpenMatches}`
    )
  }
}

export function inspectNodeRegistration(home: string, handle: string): RawNodeRegistration | null {
  const sqlite = openNodeConformanceDb(home, { readonly: true })
  try {
    return sqlite
      .query<RawNodeRegistration, [string]>(
        'SELECT handle, inbound_open, agent_public_key_pem FROM registrations WHERE handle = ?'
      )
      .get(handle)
  } finally {
    sqlite.close()
  }
}

export function assertNodeRegistration(row: RawNodeRegistration | null, expected: ExpectedNodeRegistration): void {
  const handleMatches = row?.handle === expected.handle
  const publicKeyMatches = row?.agent_public_key_pem === expected.agentPublicKeyPem
  const inboundOpenMatches = row?.inbound_open === (expected.inboundOpen ? 1 : 0)
  if (!handleMatches || !publicKeyMatches || !inboundOpenMatches) {
    throw new Error(
      `node-mailbox-ready failed: present=${row !== null} handleMatches=${handleMatches} ` +
        `publicKeyMatches=${publicKeyMatches} inboundOpenMatches=${inboundOpenMatches}`
    )
  }
}
