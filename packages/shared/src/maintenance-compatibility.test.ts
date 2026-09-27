import { describe, expect, it } from 'bun:test'
import { PLATFORM_MAINTENANCE_HEADERS, PLATFORM_MAINTENANCE_PROTOCOL_VERSION } from './maintenance-compatibility'

describe('platform maintenance compatibility protocol', () => {
  it('has a stable version and lowercase wire header names', () => {
    expect(PLATFORM_MAINTENANCE_PROTOCOL_VERSION).toBe(1)
    expect(PLATFORM_MAINTENANCE_HEADERS).toEqual({
      protocol: 'x-ficus-maintenance-protocol',
      callerVersion: 'x-ficus-caller-version',
      instanceId: 'x-ficus-instance-id',
      correlationId: 'x-ficus-correlation-id',
    })
  })
})
