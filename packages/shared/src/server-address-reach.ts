/**
 * Where a server address can be opened from, judged from the address alone. It says nothing about
 * whether the server answers there: a mobile device that can route to the address may still find nothing listening.
 *
 * - `this-computer`: loopback. Only the machine running the server.
 * - `home-network`: a private address, a `.local` name or a bare host name. Devices on the same network.
 * - `tailscale`: a Tailscale address or MagicDNS name. Devices signed in to the same tailnet.
 * - `public`: anything else. Any device, if DNS and the network path lead to the server.
 */
export type ServerAddressReach = 'none' | 'this-computer' | 'home-network' | 'tailscale' | 'public'

export interface ServerAddressClass {
  reach: ServerAddressReach
  https: boolean
}

function ipv4(host: string): [number, number, number, number] | null {
  const parts = host.split('.')
  if (parts.length !== 4) return null
  const octets = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : NaN))
  return octets.every((octet) => octet >= 0 && octet <= 255) ? (octets as [number, number, number, number]) : null
}

export function classifyServerAddress(address: string | null | undefined): ServerAddressClass {
  let url: URL
  try {
    url = new URL(address ?? '')
  } catch {
    return { reach: 'none', https: false }
  }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) return { reach: 'none', https: false }
  const https = url.protocol === 'https:'
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  const of = (reach: ServerAddressReach): ServerAddressClass => ({ reach, https })

  const v4 = ipv4(host)
  if (v4) {
    const [a, b] = v4
    if (a === 127) return of('this-computer')
    if (a === 100 && b >= 64 && b <= 127) return of('tailscale')
    if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254))
      return of('home-network')
    return of('public')
  }
  if (host.includes(':')) {
    if (host === '::1') return of('this-computer')
    // Unique local (fc00::/7) and link-local (fe80::/10).
    if (/^f[cd]/.test(host) || /^fe[89ab]/.test(host)) return of('home-network')
    return of('public')
  }
  if (host === 'localhost' || host.endsWith('.localhost')) return of('this-computer')
  if (host.endsWith('.ts.net')) return of('tailscale')
  if (host.endsWith('.local') || !host.includes('.')) return of('home-network')
  return of('public')
}
