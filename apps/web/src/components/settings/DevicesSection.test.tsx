import { describe, expect, it } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
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
