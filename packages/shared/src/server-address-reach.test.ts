import { describe, expect, test } from 'bun:test'
import { classifyServerAddress } from './server-address-reach'

describe('classifyServerAddress', () => {
  test('no address, or one that does not parse, reaches nothing', () => {
    expect(classifyServerAddress(null)).toEqual({ reach: 'none', https: false })
    expect(classifyServerAddress('not a url')).toEqual({ reach: 'none', https: false })
  })

  test('loopback names and addresses reach only this computer', () => {
    for (const url of ['http://localhost:3000', 'http://127.0.0.1:3000', 'http://127.8.9.1', 'http://[::1]:3000'])
      expect(classifyServerAddress(url).reach).toBe('this-computer')
  })

  test('private ranges, .local names and bare host names reach the home network', () => {
    for (const url of [
      'http://192.168.1.20:3000',
      'http://10.0.0.5',
      'http://172.16.0.1',
      'http://172.31.255.254',
      'http://169.254.10.10',
      'http://studio-mac.local:3000',
      'http://studio-mac:3000',
      'http://[fd12:3456::1]:3000',
      'http://[fe80::1]:3000',
    ])
      expect(classifyServerAddress(url)).toEqual({ reach: 'home-network', https: false })
    // Just outside the private ranges.
    expect(classifyServerAddress('http://172.32.0.1').reach).toBe('public')
    expect(classifyServerAddress('http://192.169.1.1').reach).toBe('public')
  })

  test('Tailscale addresses and MagicDNS names reach devices on the tailnet', () => {
    expect(classifyServerAddress('https://studio-mac.tail1234.ts.net')).toEqual({ reach: 'tailscale', https: true })
    expect(classifyServerAddress('http://100.64.0.1:3000').reach).toBe('tailscale')
    expect(classifyServerAddress('http://100.127.255.254').reach).toBe('tailscale')
    expect(classifyServerAddress('http://100.128.0.1').reach).toBe('public')
  })

  test('anything else is a public address, with or without a path', () => {
    expect(classifyServerAddress('https://ficus.example.com/ficus')).toEqual({ reach: 'public', https: true })
    expect(classifyServerAddress('http://203.0.113.9:8080')).toEqual({ reach: 'public', https: false })
  })
})
