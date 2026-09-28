// Thin shim over @ficus/client-core (see ./clientInstance).
import { client } from './clientInstance'

export type { DeviceAuthorizationPreview, DeviceSummary } from '@ficus/client-core'

export const listDevices = client.auth.listDevices
export const revokeDevice = client.auth.revokeDevice
export const startPairing = client.auth.pairStart
export const inspectDeviceAuthorization = client.auth.deviceAuthorizationInspect
export const approveDeviceAuthorization = client.auth.deviceAuthorizationApprove
