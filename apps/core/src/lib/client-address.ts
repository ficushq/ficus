import { isIP } from 'node:net'

const peerAddresses = new WeakMap<Request, string>()

function normalizeAddress(value: string | undefined | null): string | null {
  if (!value) return null
  let address = value.trim()
  if (address.startsWith('::ffff:')) address = address.slice(7)
  const zone = address.indexOf('%')
  if (zone !== -1) address = address.slice(0, zone)
  return isIP(address) ? address.toLowerCase() : null
}

function configuredTrustedProxies(): string[] {
  return (process.env.FICUS_TRUSTED_PROXY_ADDRESSES ?? '')
    .split(',')
    .map(normalizeAddress)
    .filter((address): address is string => address !== null)
}

/** Loopback peers are, by construction, processes on this host — including the local proxy. */
function isLoopback(address: string): boolean {
  return address === '::1' || address.startsWith('127.')
}

export function resolveClientAddress(input: {
  peerAddress?: string | null
  forwardedFor?: string | null
  trustedProxies?: string[]
}): string {
  const peerAddress = normalizeAddress(input.peerAddress)
  if (!peerAddress) return 'unknown'
  const trusted = new Set((input.trustedProxies ?? []).map(normalizeAddress).filter(Boolean))
  // Core never terminates TLS, so every HTTPS deployment fronts it with caddy/nginx bound to
  // the same host — the peer is always 127.0.0.1 and no deployment sets FICUS_TRUSTED_PROXY_ADDRESSES.
  // Without this, every caller on the instance shares one rate-limit bucket. The trust is gated on
  // the PEER being loopback (something only a same-host process can be), never on a header, so a
  // remote caller still cannot forge its way into the chain.
  if (isLoopback(peerAddress)) trusted.add(peerAddress)
  if (!trusted.has(peerAddress)) return peerAddress

  const forwarded = (input.forwardedFor ?? '')
    .split(',')
    .map(normalizeAddress)
    .filter((address): address is string => address !== null)
  const chain = [...forwarded, peerAddress]
  while (chain.length > 1 && trusted.has(chain[chain.length - 1])) chain.pop()
  return chain.at(-1) ?? peerAddress
}

/** Attach Bun's socket peer address before handing a request to Hono. */
export function attachPeerAddress(request: Request, peerAddress: string | undefined): void {
  const normalized = normalizeAddress(peerAddress)
  if (normalized) peerAddresses.set(request, normalized)
}

/** Resolve a rate-limit key, honoring X-Forwarded-For only from configured trusted peers. */
export function getClientAddress(request: Request): string {
  return resolveClientAddress({
    peerAddress: peerAddresses.get(request),
    forwardedFor: request.headers.get('x-forwarded-for'),
    trustedProxies: configuredTrustedProxies(),
  })
}
