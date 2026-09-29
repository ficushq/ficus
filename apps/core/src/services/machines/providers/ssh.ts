import type { Machine } from '../queries'
import { MachineProviderError, type MachineExecFn, type MachineProvider, type MachineSpec } from '../provider'

/**
 * BYO-SSH machine provider. These machines are user-owned hardware that gets
 * registered (via the machines admin API, outside this module), never
 * provisioned or destroyed by Ficus. `status()` probes reachability over SSH;
 * there is no parked state for BYO boxes.
 *
 * `exec` is injected rather than imported directly because Task 3's
 * `ssh.ts` (the real `sshExec` implementation) doesn't exist yet at the time
 * this adapter is built. Wiring code constructs the real adapter with
 * `createSshMachineProvider({ exec: sshExec })` and registers it via
 * `registerMachineProvider`.
 */
export function createSshMachineProvider(deps: { exec: MachineExecFn }): MachineProvider {
  const { exec } = deps

  return {
    key: 'ssh',

    async provision(_spec: MachineSpec): Promise<never> {
      throw new MachineProviderError('byo machines are registered, not provisioned')
    },

    async terminate(_machine: Machine): Promise<void> {
      // No-op: we never destroy user hardware.
    },

    async status(machine: Machine): Promise<'running' | 'parked' | 'gone'> {
      try {
        const result = await exec(machine, 'echo ok')
        return result.exitCode === 0 ? 'running' : 'gone'
      } catch {
        return 'gone'
      }
    },
  }
}
