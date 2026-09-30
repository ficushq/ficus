import { afterEach, describe, expect, it } from 'bun:test'
import { attachPeerAddress, isTrustedProxyPeer, resolveClientAddress } from './client-address'

describe('resolveClientAddress', () => {
  it('uses and normalizes the direct peer address', () => {
    expect(resolveClientAddress({ peerAddress: '::ffff:192.0.2.10' })).toBe('192.0.2.10')
  })

  it('ignores spoofed forwarding headers from an untrusted peer', () => {
    expect(
      resolveClientAddress({
        peerAddress: '203.0.113.5',
        forwardedFor: '198.51.100.10',
        trustedProxies: ['10.0.0.2'],
      })
    ).toBe('203.0.113.5')
  })

  it('uses the forwarded client when the direct peer is configured as trusted', () => {
    expect(
      resolveClientAddress({
        peerAddress: '10.0.0.2',
        forwardedFor: '198.51.100.10',
        trustedProxies: ['10.0.0.2'],
      })
    ).toBe('198.51.100.10')
  })

  it('gives separate legitimate clients separate limiter keys', () => {
    const trustedProxies = ['10.0.0.2']
    const first = resolveClientAddress({ peerAddress: '10.0.0.2', forwardedFor: '198.51.100.10', trustedProxies })
    const second = resolveClientAddress({ peerAddress: '10.0.0.2', forwardedFor: '198.51.100.11', trustedProxies })
    expect(first).not.toBe(second)
  })

  // Core never terminates TLS, so every HTTPS deployment fronts it with caddy/nginx on the
  // same host. Without implicit loopback trust every request through the proxy keys on
  // 127.0.0.1 and the whole instance shares one bucket. No deployment sets the env var.
  it('honors forwarding from a loopback peer with no configured proxies', () => {
    expect(resolveClientAddress({ peerAddress: '127.0.0.1', forwardedFor: '198.51.100.10' })).toBe('198.51.100.10')
    expect(resolveClientAddress({ peerAddress: '::1', forwardedFor: '198.51.100.11' })).toBe('198.51.100.11')
    expect(resolveClientAddress({ peerAddress: '::ffff:127.0.0.1', forwardedFor: '198.51.100.12' })).toBe(
      '198.51.100.12'
    )
  })

  it('gives proxied clients separate limiter keys without any configured proxies', () => {
    const first = resolveClientAddress({ peerAddress: '127.0.0.1', forwardedFor: '198.51.100.10' })
    const second = resolveClientAddress({ peerAddress: '127.0.0.1', forwardedFor: '198.51.100.11' })
    expect(first).not.toBe(second)
  })

  it('still keys a direct loopback client on the loopback address', () => {
    expect(resolveClientAddress({ peerAddress: '127.0.0.1' })).toBe('127.0.0.1')
  })

  // Implicit trust must be gated on the PEER being loopback, never on the header claiming it.
  it('does not let a remote peer inherit loopback trust by forging the chain', () => {
    expect(resolveClientAddress({ peerAddress: '203.0.113.5', forwardedFor: '198.51.100.10, 127.0.0.1' })).toBe(
      '203.0.113.5'
    )
  })
})

describe('isTrustedProxyPeer', () => {
  const previous = process.env.FICUS_TRUSTED_PROXY_ADDRESSES

  afterEach(() => {
    if (previous === undefined) delete process.env.FICUS_TRUSTED_PROXY_ADDRESSES
    else process.env.FICUS_TRUSTED_PROXY_ADDRESSES = previous
  })

  function fromPeer(peer: string | undefined): Request {
    const request = new Request('http://ficus.test/', { headers: { 'x-forwarded-for': '127.0.0.1' } })
    attachPeerAddress(request, peer)
    return request
  }

  it('trusts the same-host proxy (a loopback peer)', () => {
    delete process.env.FICUS_TRUSTED_PROXY_ADDRESSES
    expect(isTrustedProxyPeer(fromPeer('127.0.0.1'))).toBe(true)
    expect(isTrustedProxyPeer(fromPeer('::1'))).toBe(true)
    expect(isTrustedProxyPeer(fromPeer('::ffff:127.0.0.1'))).toBe(true)
  })

  it('trusts an exact configured proxy address only', () => {
    process.env.FICUS_TRUSTED_PROXY_ADDRESSES = '10.0.0.2, 10.0.0.0/8'
    expect(isTrustedProxyPeer(fromPeer('10.0.0.2'))).toBe(true)
    expect(isTrustedProxyPeer(fromPeer('10.0.0.3'))).toBe(false)
  })

  it('never trusts a remote peer, whatever its headers claim, or an unknown one', () => {
    delete process.env.FICUS_TRUSTED_PROXY_ADDRESSES
    expect(isTrustedProxyPeer(fromPeer('203.0.113.20'))).toBe(false)
    expect(isTrustedProxyPeer(fromPeer(undefined))).toBe(false)
  })
})
