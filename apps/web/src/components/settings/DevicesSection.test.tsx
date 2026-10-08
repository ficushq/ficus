import { afterEach, describe, expect, it } from 'bun:test'
import { act } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { fireEvent, getByRole, waitFor } from '@testing-library/dom'
import { notifyManager, QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { acquireDomHarness } from '../../test/domHarness'
import { queryKeys } from '../../queryKeys'
import type { DeviceSummary } from '../../api/devices'
import { DevicesSection } from './DevicesSection'
import { deviceApprovalErrorMessage, devicePlatformLabel } from './deviceAuthorizationApprovalLogic'
import { DeviceAuthorizationApproval } from './DeviceAuthorizationApproval'

describe('Paired Devices platform labels', () => {
  it('renders known platforms and safely falls back for unknown values', () => {
    expect(['ios', 'android', 'cli', 'desktop', 'future'].map(devicePlatformLabel)).toEqual([
      'iOS',
      'Android',
      'Ficus CLI',
      'Ficus Desktop',
      'Device',
    ])
  })

  it('labels desktop devices and phrases approval by platform', () => {
    expect(devicePlatformLabel('desktop')).toBe('Ficus Desktop')
    expect(deviceApprovalErrorMessage(new Error(), 'desktop')).toBe(
      'Approval failed because this request is expired or already used. Start again from Ficus Desktop.'
    )
    expect(deviceApprovalErrorMessage(new Error(), 'cli')).toContain('ficus auth login')
  })
})

describe('DeviceAuthorizationApproval heading by platform', () => {
  const expiresAt = '2030-01-01T12:00:00.000Z'

  it('renders the Ficus Desktop heading for a desktop pairing request', () => {
    const html = renderToStaticMarkup(
      <DeviceAuthorizationApproval preview={{ name: 'MacBook', platform: 'desktop', expiresAt }} onApprove={() => {}} />
    )
    expect(html).toContain('Approve Ficus Desktop sign-in')
  })

  it('renders the Ficus CLI heading for a cli pairing request', () => {
    const html = renderToStaticMarkup(
      <DeviceAuthorizationApproval preview={{ name: 'atlas', platform: 'cli', expiresAt }} onApprove={() => {}} />
    )
    expect(html).toContain('Approve Ficus CLI login')
  })
})

describe('Paired Devices pairing (shared with Mobile through usePhonePairing)', () => {
  let cleanup: (() => Promise<void>) | undefined
  afterEach(async () => {
    await cleanup?.()
    cleanup = undefined
  })
  const device = (id: string): DeviceSummary => ({
    id,
    name: id,
    platform: 'ios',
    createdAt: '2026-10-01T12:00:00.000Z',
    lastUsedAt: null,
    revokedAt: null,
  })

  it('starts pairing, keeps the QR up for known devices and closes it when a new phone pairs', async () => {
    const dom = await acquireDomHarness({ url: 'https://ficus.example.com/settings?section=devices' })
    let devices = [device('existing')]
    const requests: string[] = []
    const previousFetch = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input instanceof Request ? input.url : input))
      requests.push(`${init?.method ?? 'GET'} ${url.pathname}`)
      if (url.pathname === '/api/auth/pair/start')
        return Response.json({
          code: 'pair-code-2',
          serverUrl: 'https://ficus.example.com',
          expiresAt: new Date(Date.now() + 90_000).toISOString(),
        })
      if (url.pathname === '/api/auth/devices') return Response.json(devices)
      return Response.json({ error: 'Unexpected request' }, { status: 404 })
    }) as typeof fetch
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
    client.setQueryData(queryKeys.devices.list(), devices)
    cleanup = async () => {
      await dom.cleanup()
      client.clear()
      globalThis.fetch = previousFetch
    }
    const { root, container } = dom.createRoot()
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <DevicesSection />
        </QueryClientProvider>
      )
    )
    await dom.act(async () => fireEvent.click(getByRole(container, 'button', { name: 'Generate pairing QR' })))
    await waitFor(() => expect(container.querySelector('img[alt="Pairing QR code"]')).not.toBeNull())
    expect(requests).toContain('POST /api/auth/pair/start')

    // The device already paired before the code was minted never reads as new.
    await act(async () => {
      await client.refetchQueries({ queryKey: queryKeys.devices.list() })
      await new Promise<void>((resolve) => notifyManager.schedule(resolve))
    })
    expect(container.querySelector('img[alt="Pairing QR code"]')).not.toBeNull()

    devices = [...devices, device('new-phone')]
    await act(async () => {
      await client.refetchQueries({ queryKey: queryKeys.devices.list() })
      await new Promise<void>((resolve) => notifyManager.schedule(resolve))
    })
    expect(container.querySelector('img[alt="Pairing QR code"]')).toBeNull()
  })
})
