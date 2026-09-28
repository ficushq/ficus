import { expect, test } from 'bun:test'
import { SYSTEM_RECIPIENT_ID } from '@ficus/shared'
import { sendOAuthControlPlaneAlert } from './oauth-operational-alert'

test('broker access alert uses fixed safe content and a stable exactly-once key', async () => {
  const calls: unknown[][] = []
  const input = {
    connectionId: '80000000-0000-4000-8000-000000000001',
    providerKey: 'notion',
    materialRevision: '80000000-0000-4000-8000-000000000002',
    safeCode: 'broker_unauthorized' as const,
  }
  await sendOAuthControlPlaneAlert(input, async (...args: unknown[]) => {
    calls.push(args)
    return {} as never
  })
  await sendOAuthControlPlaneAlert(input, async (...args: unknown[]) => {
    calls.push(args)
    return {} as never
  })

  expect(calls).toHaveLength(2)
  expect(calls[0]?.[0]).toMatchObject({
    recipientType: 'system',
    recipientId: SYSTEM_RECIPIENT_ID,
    senderType: 'system',
    wakeEligible: false,
    subject: 'OAuth control plane access requires attention',
    metadata: {
      source: 'integration-oauth-control-plane',
      connectionId: input.connectionId,
      providerKey: 'notion',
      materialRevision: input.materialRevision,
      safeCode: 'broker_unauthorized',
      occurrenceClass: 'broker_access_denied',
    },
  })
  expect(calls[0]?.[1]).toBe(
    `integration-oauth-control-plane:v1:${input.connectionId}:${input.materialRevision}:broker_unauthorized`
  )
  expect(JSON.stringify(calls)).not.toContain('credential')
})

test('authority mismatch alert has a distinct occurrence classification', async () => {
  const calls: unknown[][] = []
  await sendOAuthControlPlaneAlert(
    {
      connectionId: '80000000-0000-4000-8000-000000000001',
      providerKey: 'notion',
      materialRevision: '80000000-0000-4000-8000-000000000002',
      safeCode: 'client_authority_mismatch',
    },
    async (...args: unknown[]) => {
      calls.push(args)
      return {} as never
    }
  )
  expect(calls[0]?.[0]).toMatchObject({
    metadata: { safeCode: 'client_authority_mismatch', occurrenceClass: 'client_authority_mismatch' },
  })
})
