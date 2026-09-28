import { describe, it, expect, mock } from 'bun:test'

const apiFetchMock = mock(async () => undefined as unknown)
import * as fed from './amtp'
const { queryKeys } = await import('@ficus/client-core')
const { queries } = await import('../queryOptions')

function call(response: unknown) {
  apiFetchMock.mockClear()
  apiFetchMock.mockResolvedValueOnce(response)
  return apiFetchMock
}

describe('amtp query keys', () => {
  it('builds the amtp domain keys', () => {
    expect(queryKeys.amtp.all).toEqual(['amtp'])
    expect(queryKeys.amtp.identity()).toEqual(['amtp', 'identity'])
    expect(queryKeys.amtp.peers()).toEqual(['amtp', 'peers'])
    expect(queryKeys.amtp.agentStatus('a1')).toEqual(['amtp', 'agentStatus', 'a1'])
    expect(queryKeys.amtp.allowRules('a1')).toEqual(['amtp', 'allowRules', 'a1'])
  })
})

describe('queries.amtp wiring', () => {
  it('pairs each factory with its centralized key', () => {
    expect(queries.amtp.identity().queryKey).toEqual(queryKeys.amtp.identity())
    expect(queries.amtp.peers().queryKey).toEqual(queryKeys.amtp.peers())
    expect(queries.amtp.agentStatus('a1').queryKey).toEqual(queryKeys.amtp.agentStatus('a1'))
    expect(queries.amtp.allowRules('a1').queryKey).toEqual(queryKeys.amtp.allowRules('a1'))
  })
  it('agent status calls the status endpoint', async () => {
    const m = call({ handle: null, registered: false, inboundOpen: false, allowsInbound: false, allowRules: [] })
    await fed.getAgentFederationStatus('a1', m)
    expect(m.mock.calls[0][0]).toBe('/amtp/agents/a1/status')
  })
})

describe('federation API client', () => {
  it('registers a handle via POST with a JSON handle body', async () => {
    const m = call({ handle: 'alice', address: 'amtp://inst/alice', identityPublicKey: 'PEM' })
    const res = await fed.registerAgentFederation('a1', 'alice', m)
    expect(res.address).toBe('amtp://inst/alice')
    expect(m.mock.calls[0][0]).toBe('/amtp/agents/a1/register')
    expect(m.mock.calls[0][1]?.method).toBe('POST')
    expect(JSON.parse((m.mock.calls[0][1]?.body as string) ?? '{}')).toEqual({ handle: 'alice' })
  })
  it('unregisters via DELETE', async () => {
    const m = call(undefined)
    await fed.unregisterAgentFederation('a1', m)
    expect(m.mock.calls[0][0]).toBe('/amtp/agents/a1/register')
    expect(m.mock.calls[0][1]?.method).toBe('DELETE')
  })
  it('opens and closes the mailbox via POST', async () => {
    const open = call(undefined)
    await fed.openAgentMailbox('a1', open)
    expect(open.mock.calls[0][0]).toBe('/amtp/agents/a1/open')
    expect(open.mock.calls[0][1]?.method).toBe('POST')
    const close = call(undefined)
    await fed.closeAgentMailbox('a1', close)
    expect(close.mock.calls[0][0]).toBe('/amtp/agents/a1/close')
  })
  it('adds an allow rule and omits principalValue for "any"', async () => {
    const m = call({
      id: 'r1',
      targetAgentId: 'a1',
      peerInstanceId: 'p',
      principalKind: 'any',
      principalValue: null,
      createdAt: '',
    })
    await fed.addAgentAllowRule(
      'a1',
      {
        peerInstanceId: 'p',
        principalKind: 'any',
      },
      m
    )
    expect(m.mock.calls[0][0]).toBe('/amtp/agents/a1/allow-rules')
    expect(JSON.parse((m.mock.calls[0][1]?.body as string) ?? '{}')).toEqual({
      peerInstanceId: 'p',
      principalKind: 'any',
    })
  })
  it('deletes an allow rule via DELETE', async () => {
    const m = call(undefined)
    await fed.deleteAgentAllowRule('a1', 'r1', m)
    expect(m.mock.calls[0][0]).toBe('/amtp/agents/a1/allow-rules/r1')
    expect(m.mock.calls[0][1]?.method).toBe('DELETE')
  })
  it('updates a peer via PATCH', async () => {
    const m = call({
      id: 'p1',
      localAlias: 'acme',
      instanceId: 'i',
      baseUrl: 'https://x/api',
      publicKeyPem: 'k',
      status: 'disabled',
      createdAt: '',
    })
    await fed.updatePeer('p1', { status: 'disabled' }, m)
    expect(m.mock.calls[0][0]).toBe('/amtp/peers/p1')
    expect(m.mock.calls[0][1]?.method).toBe('PATCH')
    expect(JSON.parse((m.mock.calls[0][1]?.body as string) ?? '{}')).toEqual({ status: 'disabled' })
  })
})
