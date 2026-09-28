/**
 * Platform-managed instance markers.
 *
 * On tau's hosted platform, the control plane delivers credentials it sets on a
 * tenant's behalf as environment variables in /etc/tau/managed.env (loaded by
 * systemd via EnvironmentFile). Two control vars ride along in that same file:
 *
 *   FICUS_MANAGED=1                       — this is a platform-managed instance
 *   FICUS_MANAGED_SECRET_KEYS=A,B,C       — the env-var names the platform owns
 *
 * A platform-managed secret MUST be invisible to the tenant: it is never
 * ingested into the secret store, never listed, never returned by the secrets
 * API, and never exported into a squad environment. Core services still read
 * its VALUE straight from process.env — the value never enters the tenant DB.
 *
 * Self-hosted installs set neither var. Runtime-only cloud service credentials
 * such as FICUS_PUSH_RELAY_TOKEN remain private even on self-hosted installs.
 *
 * Read from process.env at call time (not cached at import) so tests and a
 * managed.env rewrite-then-restart both take effect without special handling.
 *
 * One release (Ficus rename): the secret store keeps its retained `TAU_*` rows
 * until the bridge is removed (Task 36), while the boot bridge maps a declared
 * `TAU_X` to `FICUS_X`. So whenever `FICUS_X` is managed or private, `TAU_X` is
 * too — otherwise a retained row would surface as an ordinary, listable,
 * readable, exportable secret.
 */
import { ENV_PREFIX, LEGACY_ENV_PREFIX } from '@ficus/shared/legacy-env'

/** `FICUS_X` → `TAU_X`; any other key → null. */
function legacySpelling(key: string): string | null {
  return key.startsWith(ENV_PREFIX) ? `${LEGACY_ENV_PREFIX}${key.slice(ENV_PREFIX.length)}` : null
}

/** `TAU_X` → `FICUS_X`; any other key → null. */
function currentSpelling(key: string): string | null {
  return key.startsWith(LEGACY_ENV_PREFIX) ? `${ENV_PREFIX}${key.slice(LEGACY_ENV_PREFIX.length)}` : null
}

/** True on a tenant VM the hosted platform manages (FICUS_MANAGED=1). */
export function isPlatformManaged(): boolean {
  return process.env.FICUS_MANAGED === '1'
}

/**
 * Superseded key → the key that SUPERSEDES it (wins when both are set).
 *
 * Some credentials have two delivery shapes for the same value, and one takes
 * precedence over the other at resolve time. When the platform manages the
 * winning variant, leaving the losing one tenant-editable is an override
 * hazard, not merely a cosmetic leftover: a tenant who fills in the visible
 * field silently replaces the platform's credential with their own.
 *
 * So a key here is treated as managed whenever the key it maps to is managed.
 * Adding a future pair is one line — never new logic.
 *
 *   APNS_KEY_P8 (inline PEM) is resolved BEFORE APNS_KEY_P8_FILE (path to the
 *   PEM on disk) by resolveApnsKeyP8. The hosted platform delivers the .p8 as a
 *   file artifact + a managed APNS_KEY_P8_FILE env var, so the inline key must
 *   be managed too — otherwise a tenant-set APNS_KEY_P8 wins and moves push
 *   identity onto a tenant-supplied credential.
 *
 * Only one hop is resolved (a superseded key is derived from the DECLARED set,
 * not from other derived keys); model a chain as explicit pairs if one ever
 * appears.
 */
const SUPERSEDED_BY: Record<string, string> = {
  APNS_KEY_P8: 'APNS_KEY_P8_FILE',
}

/**
 * Secret-store key → how its platform-managed VALUE arrives in the environment.
 *
 * Most managed secrets need no entry here: the store key IS the env-var name,
 * and the value is the plaintext. Two properties of `/etc/tau/managed.env` can
 * break that, and one credential hits both.
 *
 *   NAME. The file is a systemd `EnvironmentFile`, and systemd cannot set a
 *   variable whose name contains a hyphen. The exe.dev account SSH key is
 *   stored under `exe-provider-ssh-key` (services/machines/provider-credentials.ts
 *   — a name that predates the hosted platform and is referenced by every exe
 *   machine row's sshKeyId), so its value is delivered as `EXE_PROVIDER_SSH_KEY`
 *   and resolved back here. Renaming the secret instead would be a data
 *   migration across live machine rows to fix a file-format constraint.
 *
 *   SHAPE. An EnvironmentFile value may not span lines, and an OpenSSH private
 *   key inherently does. It therefore travels base64-encoded and is decoded
 *   here, so every consumer keeps reading an ordinary PEM out of the store.
 *
 * The mapping is one-way and applies ONLY to platform-managed resolution: on a
 * self-hosted install nothing declares these keys, so the secret behaves exactly
 * as it always has (a DB row, read verbatim) and `EXE_PROVIDER_SSH_KEY` in the
 * environment means nothing at all.
 */
const MANAGED_ENV_ALIASES: Record<string, { envKey: string; encoding?: 'base64' }> = {
  'exe-provider-ssh-key': { envKey: 'EXE_PROVIDER_SSH_KEY', encoding: 'base64' },
}

const PRIVATE_MANAGED_ENV_KEYS = new Set([
  'FICUS_PLATFORM_INSTANCE_TOKEN',
  'FICUS_PLATFORM_USAGE_TOKEN',
  'FICUS_PUSH_RELAY_TOKEN',
  // One release (Ficus rename): the retained legacy rows stay private too.
  'TAU_PLATFORM_INSTANCE_TOKEN',
  'TAU_PLATFORM_USAGE_TOKEN',
  'TAU_PUSH_RELAY_TOKEN',
])

/** Runtime-only service credentials that are private even on self-hosted Core. */
const ALWAYS_PRIVATE_KEYS = new Set(['FICUS_PUSH_RELAY_TOKEN', 'TAU_PUSH_RELAY_TOKEN'])

// Visibility-only tombstones for artifact declarations retired from Core. They
// remain managed when stale declarations exist, so tenant DB values cannot
// become editable or exportable, but their names are never shown in settings.
// This set must not be used for value resolution or delivery compatibility.
const RETIRED_PUBLIC_MANAGED_ENV_KEYS = new Set([
  'NOTION_OAUTH_CLIENT_ID',
  'NOTION_OAUTH_CLIENT_SECRET',
  'GITHUB_OAUTH_CLIENT_ID',
  'GITHUB_OAUTH_CLIENT_SECRET',
])

/** Strict base64 — no whitespace, no stray characters, correct padding. */
const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/

/**
 * The value of a platform-managed secret, read from the environment under
 * whatever name (and in whatever encoding) the platform delivers it.
 *
 * Callers must have established that `key` IS managed (store.get does). An
 * undecodable value returns undefined rather than garbage: handing a consumer a
 * corrupted private key turns a delivery bug into an SSH authentication failure
 * nobody can trace back to its cause, whereas an absent credential fails where
 * it is missing and says so.
 */
export function readManagedSecretValue(key: string): string | undefined {
  const alias = MANAGED_ENV_ALIASES[key]
  if (!alias) {
    // A retained legacy key resolves to the value the bridge moved to FICUS_X.
    const current = currentSpelling(key)
    return process.env[key] ?? (current ? process.env[current] : undefined)
  }

  const raw = process.env[alias.envKey]
  if (raw === undefined || alias.encoding !== 'base64') return raw
  if (!BASE64_RE.test(raw)) return undefined

  const decoded = Buffer.from(raw, 'base64')
  // Round-trip check: Buffer.from is lenient, so re-encoding is the only way to
  // know the bytes we hand back are the bytes that were sent.
  if (decoded.toString('base64') !== raw) return undefined
  return decoded.toString('utf8')
}

/**
 * The set of SECRET-STORE keys the platform manages on this instance: the ones
 * declared in the comma-separated FICUS_MANAGED_SECRET_KEYS, plus every key
 * SUPERSEDED_BY a declared one, plus every key whose value is declared under an
 * ALIAS env name (see MANAGED_ENV_ALIASES). Empty on any self-hosted install,
 * where a superseded/aliased key stays an ordinary editable secret because
 * nothing declares its counterpart either.
 *
 * The aliased entries are what stop a stale DB row from shadowing a
 * platform-delivered value: without them `exe-provider-ssh-key` would not look
 * managed (only `EXE_PROVIDER_SSH_KEY` is declared), so the store would keep
 * serving whatever a tenant had once saved under that name.
 */
export function getManagedSecretKeys(): Set<string> {
  const raw = process.env.FICUS_MANAGED_SECRET_KEYS
  if (!raw) return new Set()
  const declared = new Set(
    raw
      .split(',')
      .map((key) => key.trim())
      .filter((key) => key.length > 0)
  )
  const managed = new Set(declared)
  for (const [superseded, superseding] of Object.entries(SUPERSEDED_BY)) {
    if (declared.has(superseding)) managed.add(superseded)
  }
  for (const [storeKey, alias] of Object.entries(MANAGED_ENV_ALIASES)) {
    if (declared.has(alias.envKey)) managed.add(storeKey)
  }
  // One release (Ficus rename): a managed FICUS_X also covers the retained TAU_X row.
  for (const key of [...managed]) {
    const legacy = legacySpelling(key)
    if (legacy) managed.add(legacy)
  }
  return managed
}

/**
 * True if `key` is a platform-managed secret on this instance — declared in
 * FICUS_MANAGED_SECRET_KEYS, or derived from it via SUPERSEDED_BY /
 * MANAGED_ENV_ALIASES. Every managed consumer (store list/get/ingest, the
 * secrets API, squad env export) goes through here or getManagedSecretKeys(),
 * so derived keys behave exactly like declared ones.
 */
/** Managed key names safe to expose through the tenant settings API. */
export function getPublicManagedSecretKeys(): Set<string> {
  return new Set(
    [...getManagedSecretKeys()].filter(
      (key) => !key.startsWith('__') && !PRIVATE_MANAGED_ENV_KEYS.has(key) && !RETIRED_PUBLIC_MANAGED_ENV_KEYS.has(key)
    )
  )
}

export function isManagedSecretKey(key: string): boolean {
  // This runtime-only service credential is private even on self-hosted Core.
  if (ALWAYS_PRIVATE_KEYS.has(key)) return true
  const raw = process.env.FICUS_MANAGED_SECRET_KEYS
  if (!raw) return false
  return getManagedSecretKeys().has(key)
}
