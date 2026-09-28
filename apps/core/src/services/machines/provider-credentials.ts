import { getSecretStore, type SecretStore } from '../secrets'
import { machineExistsWithProvider } from './queries'

/**
 * Credentials for provider-provisioned machines.
 *
 * exe.dev authenticates SSH against ACCOUNT-registered keys only (live recon
 * 2026-07-13): a key placed in a VM's own authorized_keys is REJECTED, and one
 * account key reaches EVERY VM under that account (the lobby API and every
 * provisioned VM alike). So the exe credential is the account's SSH PRIVATE key,
 * not an API token — tau runs instance-per-tenant, so one tenant's account key
 * backs all its exe VMs. It lives in the secret store (never in a machine row,
 * never logged) under {@link EXE_PROVIDER_SSH_KEY}.
 */

/** Secret-store key holding the exe.dev account SSH private key. */
export const EXE_PROVIDER_SSH_KEY = 'exe-provider-ssh-key'

/**
 * Read the configured exe.dev account SSH private key, or `null` when unset OR
 * present-but-blank (empty/whitespace-only) — the same "configured" bar
 * `services/onboarding/status.ts`'s `isSecretSet` applies (trimmed length > 0),
 * so a blank stored value never reads as a real key here either. The store
 * handle is injectable so callers/tests can avoid the DB-backed singleton.
 *
 * Async by contract (future stores may read remotely) though the current
 * secret store resolves synchronously from its in-memory cache.
 */
export async function getExeSshKey(deps: { getStore?: () => Pick<SecretStore, 'get'> } = {}): Promise<string | null> {
  const getStore = deps.getStore ?? getSecretStore
  const value = getStore().get(EXE_PROVIDER_SSH_KEY)
  return typeof value === 'string' && value.trim().length > 0 ? value : null
}

/**
 * Whether this instance is "exe-backed" — the live signal core uses in place
 * of `tenants.machineMode` (a platform-only column core has no access to; see
 * the instance's configured machine mode). True when either:
 *
 *   - the exe.dev account SSH key is configured (the ordinary case: seed.sh /
 *     the toolkit's `resolve_exe_key_path` writes it during provisioning, so
 *     by the time an admin looks at onboarding or settings it is already
 *     there), OR
 *   - no key is configured but an exe-provider machine is already registered
 *     (a rare recovery case — e.g. the key was cleared after the machine was
 *     created — where the substrate is still exe and hiding the surface would
 *     strand the admin with no way to fix it).
 *
 * A do_droplet instance has neither, ever, so this reads false there — the
 * onboarding checklist and tenant secrets UI use it to omit/hide the exe
 * surfaces (spec: hide, never delete).
 */
export async function isExeBacked(
  deps: {
    getStore?: () => Pick<SecretStore, 'get'>
    hasExeMachine?: () => Promise<boolean>
  } = {}
): Promise<boolean> {
  const configured = (await getExeSshKey(deps)) !== null
  if (configured) return true
  const hasExeMachine = deps.hasExeMachine ?? (() => machineExistsWithProvider('exe'))
  return hasExeMachine()
}

/**
 * Default OCI image exe VMs boot from: the prebaked `ficus-machine` image (exeuntu
 * + bun/nix/devbox/rootless-docker prereqs + tau scripts). PUBLIC on ghcr, so no
 * `--registry-auth` is needed. Booting from it turns box provisioning from a
 * multi-minute bootstrap install into a seconds-long boot.
 */
export const DEFAULT_EXE_MACHINE_IMAGE = 'ghcr.io/ficushq/ficus-machine:latest'

/**
 * Resolve the OCI image exe VMs boot from, configured via `FICUS_EXE_MACHINE_IMAGE`:
 *   - unset  ⇒ {@link DEFAULT_EXE_MACHINE_IMAGE} (the prebaked ficus-machine image).
 *   - a value ⇒ that image ref (a tenant override — e.g. a pinned tag).
 *   - EMPTY  ⇒ `undefined`, meaning "use exe's own default image" (the provider
 *     then omits `--image` so exe boots exeuntu). This is the explicit opt-out.
 *
 * The image is PUBLIC on ghcr, so no registry auth is threaded. A future PRIVATE
 * image would additionally need `--registry-auth` from a secret (see the hook in
 * exe-api.ts `createVm`); that plumbing is intentionally not built here.
 */
export function getExeMachineImage(): string | undefined {
  const raw = process.env.FICUS_EXE_MACHINE_IMAGE
  if (raw === undefined) return DEFAULT_EXE_MACHINE_IMAGE
  return raw === '' ? undefined : raw
}
