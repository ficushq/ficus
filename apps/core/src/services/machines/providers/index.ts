import { getExeMachineImage, getExeSshKey } from '../provider-credentials'
import { getMachineProvider, registerMachineProvider, type MachineProvider } from '../provider'
import { sshExec } from '../ssh'
import { createExeApi } from './exe-api'
import { createExeMachineProvider } from './exe'
import { createSshMachineProvider } from './ssh'

/**
 * Register the built-in machine providers.
 *
 * BYO-SSH is always registered (it needs the real `sshExec` injected, so it is
 * wired here rather than at the adapter's module init). The exe provider is
 * registered ONLY when an exe.dev account SSH key is configured — no key means
 * the tenant hasn't opted into provider-provisioned VMs, so exe stays absent
 * from the registry and any `provider:'exe'` request 400s at the route.
 *
 * The same account key drives the lobby API AND authenticates SSH to every VM
 * under the account (live recon 2026-07-13), so one key configures the whole
 * exe provider.
 *
 * Idempotent: re-registering the same provider key overwrites the identical
 * entry, so calling this twice is a no-op. Never throws when no key is set.
 *
 * `register`/`getSshKey` are injected only for tests; production uses the real
 * registry and secret-store-backed reader.
 */
export async function registerBuiltinMachineProviders(
  deps: {
    register?: typeof registerMachineProvider
    getSshKey?: typeof getExeSshKey
  } = {}
): Promise<void> {
  const register = deps.register ?? registerMachineProvider
  const getSshKey = deps.getSshKey ?? getExeSshKey

  register(createSshMachineProvider({ exec: sshExec }))

  const sshKey = await getSshKey()
  if (sshKey) {
    // FICUS_EXE_MACHINE_IMAGE selects the OCI image exe VMs boot from (the prebaked
    // ficus-machine image by default; empty ⇒ exe's default). Threaded to every
    // exe provision via the provider.
    register(createExeMachineProvider({ api: createExeApi({ token: sshKey }), image: getExeMachineImage() }))
  }
}

/**
 * Point-of-use provider lookup with self-heal.
 *
 * The registry is populated by `registerBuiltinMachineProviders`, which reads
 * the exe account key from the secret store — so a lookup can miss when the
 * caller's process registered before the store was initialized (the api's
 * router-creation registration races store init) or when the key was seeded
 * after boot. Since registration is idempotent and cheap (one secret read),
 * a miss triggers one re-register + retry instead of failing the caller.
 * Mirrors placement's `defaultGetExeProvider`; throws the original
 * `unknown machine provider` error only if the provider is genuinely absent
 * (no key configured).
 */
export async function getMachineProviderEnsured(
  key: string,
  deps: { register?: () => Promise<void>; get?: typeof getMachineProvider } = {}
): Promise<MachineProvider> {
  const get = deps.get ?? getMachineProvider
  const register = deps.register ?? registerBuiltinMachineProviders
  try {
    return get(key)
  } catch {
    await register()
    return get(key)
  }
}
