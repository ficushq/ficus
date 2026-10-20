import { isPlatformManaged } from '../../secrets/managed'
import { requireSandboxRuntime } from '../../sandbox/runtime'

/** Deployment eligibility, not configuration health. Never infer support from the UI client. */
export function bigbrainHostAvailability(): { available: boolean; reason?: string } {
  if (isPlatformManaged())
    return {
      available: false,
      reason:
        'Requires BigBrain on the same machine as a local/self-hosted Ficus instance; unavailable on Ficus Cloud.',
    }
  if (process.platform === 'win32')
    return {
      available: false,
      reason: 'BigBrain local connections require a macOS or Linux Core host; Windows is unsupported.',
    }
  try {
    // Host is an explicitly selected trusted single-user runtime, not an isolation boundary.
    // Remote agent runtimes are fine: the vault and MCP process still belong to Core.
    requireSandboxRuntime()
    return { available: true }
  } catch {
    return {
      available: false,
      reason: 'Configure a supported Ficus agent runtime on the Core host before using BigBrain.',
    }
  }
}
