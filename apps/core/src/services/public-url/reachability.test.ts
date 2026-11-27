import { describe, expect, test } from 'bun:test'
import {
  checkAddress,
  homeNetworkAddresses,
  matchesAddressProbe,
  parseTailscaleStatus,
  phoneReachReport,
} from './reachability'

const lan = (address: string, internal = false) => ({ address, family: 'IPv4' as const, internal })

describe('homeNetworkAddresses', () => {
  test('a Mac offers its Bonjour name first, which survives a new IP, then each private IPv4 address', () => {
    const addresses = homeNetworkAddresses({
      interfaces: { lo0: [lan('127.0.0.1', true)], en0: [lan('192.168.1.20')], utun4: [lan('100.101.102.103')] },
      hostname: 'Studio-Mac.local',
      platform: 'darwin',
      port: 3000,
    })
    expect(addresses).toEqual(['http://studio-mac.local:3000', 'http://192.168.1.20:3000'])
  })

  test('elsewhere only addresses are offered: a .local name needs a responder we cannot assume', () => {
    const addresses = homeNetworkAddresses({
      interfaces: { eth0: [lan('10.0.0.7')], docker0: [lan('172.17.0.1')], wan: [lan('203.0.113.4')] },
      hostname: 'box',
      platform: 'linux',
      port: 8080,
    })
    // Public addresses are not home-network addresses, and docker0 is a bridge on this machine, not the network.
    expect(addresses).toEqual(['http://10.0.0.7:8080'])
  })

  test('virtual interfaces (container and VM bridges, tunnels) are left out: a phone cannot route to them', () => {
    const addresses = homeNetworkAddresses({
      interfaces: {
        en0: [lan('192.168.1.20')],
        bridge100: [lan('192.168.215.1')],
        bridge103: [lan('10.248.0.1')],
        'br-4f2a': [lan('172.18.0.1')],
        veth12: [lan('172.19.0.1')],
        vmnet8: [lan('192.168.64.1')],
        virbr0: [lan('192.168.122.1')],
        en1: [lan('192.168.1.21')],
      },
      hostname: 'box',
      platform: 'linux',
      port: 3000,
    })
    expect(addresses).toEqual(['http://192.168.1.20:3000', 'http://192.168.1.21:3000'])
  })

  test('at most three addresses are offered', () => {
    const interfaces = Object.fromEntries([1, 2, 3, 4, 5].map((n) => [`en${n}`, [lan(`192.168.${n}.2`)]]))
    expect(homeNetworkAddresses({ interfaces, hostname: 'box', platform: 'linux', port: 3000 })).toHaveLength(3)
  })
})

describe('parseTailscaleStatus', () => {
  const running = JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'studio-mac.tail1234.ts.net.' } })
  const onPath = { output: running, command: 'tailscale', kind: 'path' as const }

  test('a running node gives its HTTPS address and the one command that serves Ficus there', () => {
    expect(parseTailscaleStatus(onPath, 3000)).toEqual({
      state: 'running',
      cli: 'path',
      address: 'https://studio-mac.tail1234.ts.net',
      serveCommand: 'tailscale serve --bg http://127.0.0.1:3000',
    })
  })

  test('the Mac app without its command-line tool installed: the command names the copy inside the app', () => {
    const app = '/Applications/Tailscale.app/Contents/MacOS/Tailscale'
    const report = parseTailscaleStatus({ output: running, command: app, kind: 'app' }, 3000)
    // `tailscale serve …` would fail there with "command not found".
    expect(report.cli).toBe('app')
    expect(report.serveCommand).toBe(`${app} serve --bg http://127.0.0.1:3000`)
  })

  test('installed but signed out or stopped is reported as such, with no address', () => {
    const stopped = (state: object) => parseTailscaleStatus({ ...onPath, output: JSON.stringify(state) }, 3000)
    expect(stopped({ BackendState: 'NeedsLogin' }).state).toBe('stopped')
    expect(stopped({ BackendState: 'Stopped', Self: {} }).address).toBeUndefined()
  })

  test('no Tailscale found, or a status that does not parse, is "not installed"', () => {
    expect(parseTailscaleStatus(null, 3000)).toEqual({
      state: 'not-installed',
      cli: null,
      serveCommand: 'tailscale serve --bg http://127.0.0.1:3000',
    })
    expect(parseTailscaleStatus({ ...onPath, output: 'not json' }, 3000).state).toBe('not-installed')
    expect(parseTailscaleStatus({ ...onPath, output: null }, 3000).state).toBe('not-installed')
  })
})

describe('phoneReachReport', () => {
  test('describes the current address, the listener and what this machine could offer', async () => {
    const report = await phoneReachReport({
      currentUrl: 'http://localhost:3000',
      bindHost: '127.0.0.1',
      port: 3000,
      interfaces: { en0: [lan('192.168.1.20')] },
      hostname: 'studio-mac',
      platform: 'darwin',
      tailscaleStatus: async () => null,
    })
    expect(report.current).toEqual({ url: 'http://localhost:3000', reach: 'this-computer', https: false })
    // Loopback only: other devices cannot connect until the server listens on the network.
    expect(report.listening).toEqual({
      host: '127.0.0.1',
      port: 3000,
      beyondThisComputer: false,
      desktopManaged: false,
    })
    expect(report.homeNetwork.addresses[0]).toBe('http://studio-mac.local:3000')
    expect(report.tailscale.state).toBe('not-installed')
  })

  test('a server bound to every interface is listening beyond this computer', async () => {
    const report = await phoneReachReport({
      currentUrl: null,
      bindHost: '0.0.0.0',
      port: 3000,
      interfaces: {},
      hostname: 'box',
      platform: 'linux',
      tailscaleStatus: async () => null,
    })
    expect(report.listening.beyondThisComputer).toBe(true)
    expect(report.current.reach).toBe('none')
  })

  test('says when Ficus Desktop decides what the server listens on, since its owner cannot set HOST', async () => {
    const report = await phoneReachReport({
      currentUrl: 'http://localhost:61896',
      bindHost: '127.0.0.1',
      port: 61896,
      desktopManaged: true,
      interfaces: {},
      hostname: 'studio-mac',
      platform: 'darwin',
      tailscaleStatus: async () => null,
    })
    expect(report.listening.desktopManaged).toBe(true)
  })
})

describe('checkAddress', () => {
  const reasonOf = (result: Awaited<ReturnType<typeof checkAddress>>) => (result.ok ? 'ok' : result.reason)
  const token = 'probe-token'
  const answering = (status: number) => async () => new Response(null, { status })

  test('asks the address for this server’s own one-time probe and accepts only its answer', async () => {
    const requested: string[] = []
    const result = await checkAddress('https://ficus.example.com/ficus/', {
      token,
      fetch: async (url) => {
        requested.push(String(url))
        return new Response(null, { status: 204 })
      },
    })
    expect(requested).toEqual(['https://ficus.example.com/ficus/health/address-check/probe-token'])
    expect(result).toEqual({ ok: true })
  })

  test('something else answering there is "not this server", not success', async () => {
    expect(await checkAddress('https://example.com', { token, fetch: answering(404) })).toEqual({
      ok: false,
      reason: 'not-this-server',
    })
    expect((await checkAddress('https://example.com', { token, fetch: answering(200) })).ok).toBe(false)
  })

  test('nothing answering is "unreachable"; a slow answer is "timeout"; a bad certificate is "certificate"', async () => {
    const failing = (error: Error) => async () => {
      throw error
    }
    expect(
      await checkAddress('http://192.168.1.20:3000', { token, fetch: failing(new Error('ECONNREFUSED')) })
    ).toEqual({ ok: false, reason: 'unreachable' })
    const timeout = Object.assign(new Error('The operation timed out'), { name: 'TimeoutError' })
    expect(reasonOf(await checkAddress('https://x.example', { token, fetch: failing(timeout) }))).toBe('timeout')
    const tls = Object.assign(new Error('unable to verify the first certificate'), {
      code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    })
    expect(reasonOf(await checkAddress('https://x.example', { token, fetch: failing(tls) }))).toBe('certificate')
  })

  test('an address that is not http(s) is refused without a request', async () => {
    let called = false
    const result = await checkAddress('ftp://example.com', {
      token,
      fetch: async () => {
        called = true
        return new Response(null)
      },
    })
    expect(result).toEqual({ ok: false, reason: 'invalid' })
    expect(called).toBe(false)
  })
})

describe('matchesAddressProbe', () => {
  test('only the exact token for this process matches', () => {
    expect(matchesAddressProbe('abc', 'abc')).toBe(true)
    expect(matchesAddressProbe('abd', 'abc')).toBe(false)
    expect(matchesAddressProbe('', 'abc')).toBe(false)
    expect(matchesAddressProbe('abcd', 'abc')).toBe(false)
  })
})
