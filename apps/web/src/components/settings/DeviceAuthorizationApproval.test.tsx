import { describe, expect, it } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { DeviceAuthorizationApproval } from './DeviceAuthorizationApproval'
import {
  approveDeviceRequest,
  deviceApprovalErrorMessage,
  parseDeviceRequest,
} from './deviceAuthorizationApprovalLogic'

const preview = { name: 'Ficus CLI on atlas', platform: 'cli' as const, expiresAt: '2030-01-01T12:00:00.000Z' }

describe('DeviceAuthorizationApproval', () => {
  it('reads device_request safely and rejects malformed fragment escapes', () => {
    expect(parseDeviceRequest('#device_request=verify%2Dcode')).toBe('verify-code')
    expect(parseDeviceRequest('#device_request=%ZZ')).toBe('')
    expect(parseDeviceRequest('#other=value')).toBe('')
  })

  it('shows the inspected client details and explicit approval action', () => {
    const html = renderToStaticMarkup(<DeviceAuthorizationApproval preview={preview} onApprove={() => {}} />)
    expect(html).toContain('Ficus CLI on atlas')
    expect(html).toContain('Approve')
    expect(html).toContain('2030')
  })

  it('invokes approval and clears the fragment only after success', async () => {
    const calls: string[] = []
    await approveDeviceRequest({
      verificationCode: 'verify-code',
      approve: async (input) => calls.push(input.verificationCode),
      clearFragment: () => calls.push('cleared'),
    })
    expect(calls).toEqual(['verify-code', 'cleared'])
  })

  it('keeps the fragment and provides actionable expired/reused failure feedback', async () => {
    let cleared = false
    const error = await approveDeviceRequest({
      verificationCode: 'expired',
      approve: async () => {
        throw new Error('Unauthorized (401)')
      },
      clearFragment: () => {
        cleared = true
      },
    }).catch((cause) => cause)

    expect(cleared).toBe(false)
    const message = deviceApprovalErrorMessage(error)
    expect(message).toContain('expired or already used')
    expect(message).toContain('ficus auth login')
    expect(
      renderToStaticMarkup(<DeviceAuthorizationApproval preview={preview} error={message} onApprove={() => {}} />)
    ).toContain(message)
  })
})
