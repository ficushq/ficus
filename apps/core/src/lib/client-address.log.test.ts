import { describe, expect, test } from 'bun:test'
import { attachPeerAddress, getClientAddress } from './client-address'

/**
 * The identity fields the http request line reports.
 *
 * A request storm on this instance was undiagnosable for hours because every
 * caller is 127.0.0.1 (core never terminates TLS; sandboxes arrive via the VM's
 * NAT) and HTTP keep-alive decouples connection counts from callers. These
 * assertions pin the two fields that actually discriminate.
 */
describe('http log client identity', () => {
  test('reports the peer address for a non-loopback caller', () => {
    const request = new Request('http://ficus.test/api/agents')
    attachPeerAddress(request, '10.1.2.3')
    expect(getClientAddress(request)).toBe('10.1.2.3')
  })

  test('a loopback peer with no forwarded header still resolves to loopback, not unknown', () => {
    // This is the sandbox/VM case — it must be reported, not swallowed.
    const request = new Request('http://ficus.test/api/agents')
    attachPeerAddress(request, '127.0.0.1')
    expect(getClientAddress(request)).toBe('127.0.0.1')
  })

  test('a loopback peer honours x-forwarded-for, so a proxied caller is not hidden', () => {
    const request = new Request('http://ficus.test/api/agents', {
      headers: { 'x-forwarded-for': '203.0.113.9' },
    })
    attachPeerAddress(request, '127.0.0.1')
    expect(getClientAddress(request)).toBe('203.0.113.9')
  })

  test('a NON-loopback peer must NOT honour x-forwarded-for — a remote caller cannot forge it', () => {
    const request = new Request('http://ficus.test/api/agents', {
      headers: { 'x-forwarded-for': '203.0.113.9' },
    })
    attachPeerAddress(request, '10.1.2.3')
    expect(getClientAddress(request)).toBe('10.1.2.3')
  })

  test('an unknown peer degrades to a named value rather than throwing', () => {
    expect(getClientAddress(new Request('http://ficus.test/api/agents'))).toBe('unknown')
  })
})
