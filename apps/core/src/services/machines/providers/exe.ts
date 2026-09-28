import { MachineProviderError, type MachineProvider, type MachineSpec, type ProvisionedMachine } from '../provider'
import type { Machine } from '../queries'
import type { ExeApi } from './exe-api'

/**
 * exe.dev machine provider. Unlike the BYO-SSH adapter, exe machines ARE
 * provisioned and destroyed by tau: `provision` spins up a KVM VM via
 * {@link ExeApi} and hands back its SSH endpoint, after which slices 1-4
 * (bootstrap, boxes, tunnels, lifecycle) run over that endpoint unchanged.
 *
 * All exe.dev wire specifics live in {@link ExeApi} (see exe-api.ts) — this
 * adapter depends only on that interface, so the wire format can be corrected in
 * one place without touching provider logic.
 *
 * No key injection: exe.dev authenticates SSH against ACCOUNT-registered keys
 * only (live recon 2026-07-13), so the account key already reaches every VM and
 * `provision` neither generates nor injects a per-machine key.
 *
 * park/resume are intentional no-ops: exe.dev VMs have no explicit
 * pause/snapshot and an idle VM is ~free (live recon 2026-07-13), so there is
 * nothing to park. Lifecycle keeps the row and the disk persists.
 */
export function createExeMachineProvider(deps: { api: ExeApi; image?: string }): MachineProvider {
  const { api, image } = deps

  return {
    key: 'exe',

    async provision(spec: MachineSpec): Promise<ProvisionedMachine> {
      // Provision by name only: exe rejects per-VM keys (the account key already
      // reaches every VM) and sizing uses defaults, so nothing else is threaded.
      // spec.publicKey/sizeHint are intentionally ignored (see module doc).
      //
      // `image` (from FICUS_EXE_MACHINE_IMAGE) selects the prebaked ficus-machine
      // image so the VM boots the toolchain instead of installing it. When unset
      // it is omitted and exe boots its default image (see getExeMachineImage).
      const vm = await api.createVm({ name: spec.name, ...(image ? { image } : {}) })
      return {
        sshHost: vm.sshHost,
        sshPort: vm.sshPort,
        sshUser: vm.sshUser,
        providerRef: vm.ref,
      }
    },

    async terminate(machine: Machine): Promise<void> {
      if (!machine.providerRef) {
        throw new MachineProviderError(`exe machine ${machine.id} has no providerRef to terminate`)
      }
      await api.destroyVm(machine.providerRef)
    },

    async status(machine: Machine): Promise<'running' | 'parked' | 'gone'> {
      // No ref ⇒ the VM was never (successfully) provisioned ⇒ gone.
      if (!machine.providerRef) return 'gone'
      const vm = await api.getVm(machine.providerRef)
      if (!vm || vm.state === 'gone') return 'gone'
      return vm.state === 'stopped' ? 'parked' : 'running'
    },

    async park(_machine: Machine): Promise<void> {
      // No-op: exe.dev has no pause; idle ≈ free. See module doc.
    },

    async resume(_machine: Machine): Promise<void> {
      // No-op: exe.dev VMs are always reachable while they exist. See module doc.
    },
  }
}
