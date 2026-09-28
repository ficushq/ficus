import type { WorkInterestSnapshot } from '@ficus/shared'
import type { Transport } from '../transport'

export interface RegisteredDevice {
  id: string
}

export interface PushDeviceRegistration {
  id: string
  platform: string
  environment: string
  createdAt: string
}

/** A Live Activity token is minted per activity (`update`) or per install (`start`). */
export interface LiveActivityTokenRegistration {
  apnsToken: string
  kind: 'start' | 'update'
  /** Required for `update`; ignored for `start`, which is not bound to an activity. */
  activityId?: string
  environment?: string
}

/** Native (APNs/FCM) device registration for the mobile app. */
export function pushResource(t: Transport) {
  return {
    enrollInstancePro: (input: {
      publicKey: string
      label: string
    }): Promise<import('@ficus/shared/push-relay').ActivationChallenge> =>
      t.request('/push/instance-pro/enroll', { method: 'POST', body: input }),
    getRelayConfig: (): Promise<{ enabled: boolean; instanceId?: string }> => t.request('/push/relay-config'),
    getWorkInterestSnapshot: (): Promise<WorkInterestSnapshot> => t.request('/push/work-interest'),
    listDevices: (): Promise<PushDeviceRegistration[]> => t.request('/push/device'),
    registerDevice: (input: {
      apnsToken: string
      platform: string
      environment?: string
      relayBindingToken?: string
    }): Promise<RegisteredDevice> => t.request('/push/device', { method: 'POST', body: input }),
    unregisterDevice: (id: string): Promise<void> => t.request(`/push/device/${id}`, { method: 'DELETE' }),

    // Live Activity tokens are separate from device tokens: they need a different APNs topic and
    // push type, and `update` tokens die with their activity (~8h, or on dismissal/reboot), so the
    // app re-registers often and the server upserts by token.
    registerLiveActivityToken: (input: LiveActivityTokenRegistration): Promise<RegisteredDevice> =>
      t.request('/push/live-activity', { method: 'POST', body: input }),
    // Keyed by the token itself, not a row id — the app only ever holds what ActivityKit gave it.
    unregisterLiveActivityToken: (apnsToken: string): Promise<void> =>
      t.request('/push/live-activity', { method: 'DELETE', body: { apnsToken } }),
  }
}
