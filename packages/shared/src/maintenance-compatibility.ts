export const PLATFORM_MAINTENANCE_PROTOCOL_VERSION = 1
export const PLATFORM_MAINTENANCE_HEADERS = {
  protocol: 'x-ficus-maintenance-protocol',
  callerVersion: 'x-ficus-caller-version',
  instanceId: 'x-ficus-instance-id',
  correlationId: 'x-ficus-correlation-id',
} as const

export interface PlatformMaintenanceCompatibilityContext {
  protocolVersion: number | null
  callerVersion: string | null
  instanceId: string | null
  correlationId: string | null
}
