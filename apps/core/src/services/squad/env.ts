import { deploymentProviderForSecret, getDeploymentAwareSecretValue } from '../integrations/deployment/settings'
import { join } from 'path'
import { existsSync, mkdirSync, writeFileSync, readFileSync, chmodSync, renameSync, rmSync } from 'fs'
import { eq, isNull } from 'drizzle-orm'
import { db, squads, squadSecretExposures, globalSecretExposures } from '../../db'
import { isManagedSecretKey } from '../secrets'
import { loadProtectedIntegrationBindings } from '../integrations/projection/protected-env'
import { githubSigningPublicKeyForSquad } from '../integrations/github/commit-signing-store'
import { getSquadWorkspacePath } from './workspace'
import {
  ensureWorkspaceDotDir,
  prepareWorkspaceDotDir,
  workspaceDotPath,
  WorkspaceDotDirConflictError,
} from '../workspace/dot-dir'
import { createLogger } from '../../lib/infra/logger'

const log = createLogger('squad-env')

/**
 * Runs one squad's step of an env regeneration that may span many squads. A squad whose workspace
 * dot dir needs a manual fix is skipped with a warning, so it cannot stop every other squad's env
 * from being regenerated (a rotated or deleted secret must still leave the others).
 */
async function skipConflictedSquad(squadId: string, run: () => Promise<void>): Promise<void> {
  try {
    await run()
  } catch (error) {
    if (!(error instanceof WorkspaceDotDirConflictError)) throw error
    log.warn(`Skipped regenerating the env of squad ${squadId}: ${error.message}`)
  }
}

const USER_ENV_FILE = 'env.user'
const GENERATED_ENV_FILE = '.env'
const GENERATED_SECRET_MARKER = '# Generated from Ficus Secret Store allowlist. Do not edit values here.'
const GENERATED_INTEGRATION_MARKER = '# Generated protected integration bindings. Do not edit values here.'

/**
 * Get the .ficus directory path for a squad workspace. A workspace still under the legacy dot dir
 * is moved first (see services/workspace/dot-dir.ts), so this process never reads an empty `.ficus`
 * while the env is still beside it.
 */
function getFicusDir(squadId: string): string {
  const workspacePath = getSquadWorkspacePath(squadId)
  prepareWorkspaceDotDir(workspacePath)
  return workspaceDotPath(workspacePath)
}

/**
 * Ensure the .ficus directory exists.
 */
function ensureFicusDir(squadId: string): string {
  const workspacePath = getSquadWorkspacePath(squadId)
  mkdirSync(workspacePath, { recursive: true })
  const ficusDir = ensureWorkspaceDotDir(workspacePath)

  // K8s sandboxes can write to the same workspace from container-root. Keep
  // Ficus's private workspace dir group-writable/setgid when Core owns it so
  // local k3d shared-volume files remain writable by the Core process.
  try {
    chmodSync(ficusDir, 0o2775)
  } catch {
    // If an older sandbox already left this root-owned, the caller will still
    // get the original write error with path context; local repair is required.
  }

  return ficusDir
}

function getUserEnvPath(squadId: string): string {
  return join(getFicusDir(squadId), USER_ENV_FILE)
}

function getGeneratedEnvPath(squadId: string): string {
  return join(getFicusDir(squadId), GENERATED_ENV_FILE)
}

const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * Keys a squad env may never set, each with the reason the writer is told.
 *
 * The squad `.ficus/.env` is sourced INSIDE every agent shell, so these decide
 * WHICH instance an agent talks to and AS WHOM. Exact, case-sensitive names —
 * these are literal env names, not a namespace.
 */
const IDENTITY_REASON =
  "the agent's identity is injected by Ficus; setting it here would make agents act as a different identity"

export const RESERVED_SQUAD_ENV_KEYS: Readonly<Record<string, string>> = {
  FICUS_TOKEN: IDENTITY_REASON,
  FICUS_API_URL: IDENTITY_REASON,
  FICUS_PASSWORD: IDENTITY_REASON,
  FICUS_AUTH_STORE: IDENTITY_REASON,
  FICUS_AGENT_CONTEXT: IDENTITY_REASON,
  FICUS_AGENT_ID: IDENTITY_REASON,
  FICUS_IDENTITY_API_URL: IDENTITY_REASON,
  FICUS_IDENTITY_TOKEN: IDENTITY_REASON,
  FICUS_IDENTITY_AUTH_STORE: IDENTITY_REASON,
  FICUS_IDENTITY_AGENT_ID: IDENTITY_REASON,
}

// PATH is deliberately NOT reserved: `PATH=$PATH:/opt/toolchain` is a legitimate
// squad env, and the host preamble re-prepends the `ficus` shim dir after the file
// is sourced, so squad additions are honoured but cannot displace `ficus`.

const ENV_ASSIGNMENT_PATTERN = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/

/**
 * Reserved keys assigned by squad env `content`, in the order they appear.
 *
 * This is a line-anchored scan of a file that is later executed as shell, so it
 * is a guardrail against the accident and against stale/naive content — not a
 * boundary. The enforcement that holds is the host preamble, which re-asserts
 * the identity and PATH after the file is sourced.
 */
export function findReservedSquadEnvKeys(content: string): string[] {
  const found: string[] = []
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const key = ENV_ASSIGNMENT_PATTERN.exec(trimmed)?.[1]
    if (key && key in RESERVED_SQUAD_ENV_KEYS && !found.includes(key)) found.push(key)
  }
  return found
}

/** The 400 message for a rejected write, naming every offending key and why it is refused. */
export function describeReservedSquadEnvKeys(keys: string[]): string {
  return keys.map((key) => `Cannot set ${key} in the squad environment: ${RESERVED_SQUAD_ENV_KEYS[key]}.`).join(' ')
}

function normalizeSecretKeys(keys: string[]): string[] {
  return Array.from(
    new Set(
      keys
        .map((key) => key.trim())
        .filter((key) => ENV_NAME_PATTERN.test(key))
        // Platform-managed credentials must NEVER reach a squad/sandbox env,
        // even if a tenant names one explicitly in the exposure allowlist. This
        // is the single chokepoint: every persistence and render path routes
        // exposure keys through here, so a managed key can neither be stored as
        // an exposure nor rendered into .ficus/.env.
        .filter((key) => !isManagedSecretKey(key))
        .filter(
          (key) =>
            !/^(?:GH_TOKEN|GITHUB_TOKEN)(?:_|$)/.test(key) &&
            key !== 'GITHUB_WEBHOOK_SECRET' &&
            key !== 'GITHUB_USER' &&
            key !== 'DEPLOY_GITHUB_PAGES_TOKEN'
        )
        // Same reasoning for the identity/PATH names: a Secret Store key called
        // FICUS_API_URL would otherwise be RENDERED into .ficus/.env and sourced into
        // every agent shell, which is the very thing the write-time check refuses.
        .filter((key) => !(key in RESERVED_SQUAD_ENV_KEYS))
    )
  ).sort()
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`
}

function renderSecretExports(keys: string[], getSecretValue: (key: string) => string | undefined): string {
  const lines = normalizeSecretKeys(keys)
    .map((key) => {
      const value = getSecretValue(key)
      if (value === undefined) return deploymentProviderForSecret(key) ? `unset ${key}` : null
      return `export ${key}=${shellQuote(value)}`
    })
    .filter((line): line is string => line !== null)

  if (lines.length === 0) return ''
  return [GENERATED_SECRET_MARKER, ...lines].join('\n')
}

function renderGeneratedEnvContent(
  content: string,
  keys: string[],
  getSecretValue: (key: string) => string | undefined,
  protectedBindings: readonly (readonly [string, string])[] = []
): string {
  const userContent = content.trimEnd()
  const secretContent = renderSecretExports(keys, getSecretValue)
  const protectedContent =
    protectedBindings.length === 0
      ? ''
      : [
          GENERATED_INTEGRATION_MARKER,
          ...[...protectedBindings]
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([name, value]) => `export ${name}=${shellQuote(value)}`),
        ].join('\n')
  // Clear inherited credentials on every shell invocation, including after
  // a default account is detached. Only current integration bindings restore them.
  return [
    userContent,
    secretContent,
    GENERATED_INTEGRATION_MARKER,
    'unset GH_TOKEN GITHUB_TOKEN GITHUB_USER DEPLOY_GITHUB_PAGES_TOKEN',
    protectedContent,
  ]
    .filter(Boolean)
    .join('\n\n')
}

function getUserEnvContentForGeneration(squadId: string): string {
  const userEnvPath = getUserEnvPath(squadId)
  if (existsSync(userEnvPath)) return readFileSync(userEnvPath, 'utf-8')

  // First-time migration for squads that only have the pre-env.user .ficus/.env file.
  // Capture legacy user content before generating selected Secret Store exports so
  // first exposure does not drop existing user variables.
  const generatedEnvPath = getGeneratedEnvPath(squadId)
  if (existsSync(generatedEnvPath)) {
    const legacyContent = readFileSync(generatedEnvPath, 'utf-8')
    if (legacyContent.includes(GENERATED_SECRET_MARKER) || legacyContent.includes(GENERATED_INTEGRATION_MARKER))
      return ''
    writeFileSync(userEnvPath, legacyContent, { mode: 0o600 })
    return legacyContent
  }

  return ''
}

async function writeGeneratedEnvFile(
  squadId: string,
  content: string,
  keys: string[],
  getSecretValue: (key: string) => string | undefined = getDeploymentAwareSecretValue
): Promise<void> {
  const ficusDir = ensureFicusDir(squadId)
  const envPath = join(ficusDir, GENERATED_ENV_FILE)
  const tempPath = join(ficusDir, `.env.tmp-${crypto.randomUUID()}`)
  let protectedBindings: readonly (readonly [string, string])[]
  let signingPublicKey: string | undefined
  try {
    protectedBindings = await loadProtectedIntegrationBindings(squadId)
    signingPublicKey = await githubSigningPublicKeyForSquad(squadId)
  } catch (error) {
    rmSync(envPath, { force: true })
    throw error
  }
  try {
    writeFileSync(
      tempPath,
      renderGeneratedEnvContent(content, keys, getSecretValue, protectedBindings) +
        '\n' +
        githubCommandBindings(squadId, signingPublicKey),
      {
        mode: 0o600,
      }
    )
    chmodSync(tempPath, 0o600)
    renameSync(tempPath, envPath)
    chmodSync(envPath, 0o600)
  } catch (error) {
    rmSync(tempPath, { force: true })
    rmSync(envPath, { force: true })
    throw error
  }
}

/**
 * Get the user-authored squad env content. This intentionally excludes selected
 * Secret Store values so normal APIs/UI do not leak plaintext secrets.
 */
export function getEnvFile(squadId: string): string | null {
  const userEnvPath = getUserEnvPath(squadId)
  if (existsSync(userEnvPath)) return readFileSync(userEnvPath, 'utf-8')

  // Backwards compatibility for squads created before env.user existed.
  // If the generated marker is present, .env may contain plaintext Secret Store values;
  // never expose those values through normal APIs/UI.
  const generatedEnvPath = getGeneratedEnvPath(squadId)
  if (!existsSync(generatedEnvPath)) return null
  const content = readFileSync(generatedEnvPath, 'utf-8')
  if (content.includes(GENERATED_SECRET_MARKER) || content.includes(GENERATED_INTEGRATION_MARKER)) return ''
  return content
}

/**
 * Set the user-authored squad env content and regenerate the sandbox .env file.
 */
export async function setEnvFile(squadId: string, content: string): Promise<void> {
  const ficusDir = ensureFicusDir(squadId)
  const userEnvPath = join(ficusDir, USER_ENV_FILE)
  writeFileSync(userEnvPath, content, { mode: 0o600 })
  await writeGeneratedEnvFile(squadId, content, await getEffectiveExposedSecretKeys(squadId))
}

/** List Secret Store keys explicitly allowed to be rendered into this squad's sandbox env. */
export async function getExposedSecretKeys(squadId: string): Promise<string[]> {
  const rows = await db
    .select({ secretKey: squadSecretExposures.secretKey })
    .from(squadSecretExposures)
    .where(eq(squadSecretExposures.squadId, squadId))
  return normalizeSecretKeys(rows.map((row) => row.secretKey))
}

export async function getGloballyExposedSecretKeys(): Promise<string[]> {
  const rows = await db.select({ secretKey: globalSecretExposures.secretKey }).from(globalSecretExposures)
  return normalizeSecretKeys(rows.map((row) => row.secretKey))
}

async function getEffectiveExposedSecretKeys(squadId: string, squadKeys?: string[]): Promise<string[]> {
  const [globalKeys, resolvedSquadKeys] = await Promise.all([
    getGloballyExposedSecretKeys(),
    squadKeys ? Promise.resolve(normalizeSecretKeys(squadKeys)) : getExposedSecretKeys(squadId),
  ])
  return normalizeSecretKeys([...globalKeys, ...resolvedSquadKeys])
}

/**
 * Regenerate one squad's sandbox `.env` from its stored content and exposures. Callers loop it over
 * many squads (exposure, integration and connection changes), so a squad whose workspace dot dir
 * needs a manual fix is skipped with a warning rather than stopping the rest.
 */
export async function regenerateEnvFileForSquad(squadId: string): Promise<void> {
  await skipConflictedSquad(squadId, async () =>
    writeGeneratedEnvFile(squadId, getEnvFile(squadId) ?? '', await getEffectiveExposedSecretKeys(squadId))
  )
}

export async function setGloballyExposedSecretKeys(keys: string[]): Promise<void> {
  const normalizedKeys = normalizeSecretKeys(keys)

  await db.delete(globalSecretExposures)
  if (normalizedKeys.length > 0) {
    await db.insert(globalSecretExposures).values(
      normalizedKeys.map((key) => ({
        secretKey: key,
        updatedAt: new Date(),
      }))
    )
  }

  const allSquads = await db.select({ id: squads.id }).from(squads).where(isNull(squads.archivedAt))
  for (const squad of allSquads) {
    await regenerateEnvFileForSquad(squad.id)
  }
}

/**
 * Set the explicit Secret Store allowlist for a squad and regenerate .ficus/.env.
 * Only selected keys are rendered; unselected secrets are never exposed.
 */
export async function setExposedSecretKeys(squadId: string, keys: string[]): Promise<void> {
  const normalizedKeys = normalizeSecretKeys(keys)
  const userContent = getUserEnvContentForGeneration(squadId)

  await db.delete(squadSecretExposures).where(eq(squadSecretExposures.squadId, squadId))
  if (normalizedKeys.length > 0) {
    await db.insert(squadSecretExposures).values(
      normalizedKeys.map((key) => ({
        squadId,
        secretKey: key,
        updatedAt: new Date(),
      }))
    )
  }

  await writeGeneratedEnvFile(squadId, userContent, await getEffectiveExposedSecretKeys(squadId, normalizedKeys))
}

/** Regenerate sandbox env files for squads that expose the changed Secret Store key. */
export async function regenerateEnvFilesForSecretKey(key: string): Promise<void> {
  const globalKeys = await getGloballyExposedSecretKeys()
  const rows = globalKeys.includes(key)
    ? await db.select({ squadId: squads.id }).from(squads).where(isNull(squads.archivedAt))
    : await db
        .select({ squadId: squadSecretExposures.squadId })
        .from(squadSecretExposures)
        .where(eq(squadSecretExposures.secretKey, key))
  for (const { squadId } of rows) {
    await skipConflictedSquad(squadId, async () => {
      const keys = await getEffectiveExposedSecretKeys(squadId)
      await writeGeneratedEnvFile(squadId, getEnvFile(squadId) ?? '', keys)
    })
  }
}

/** Test helper for rendering selected secrets without touching the real Secret Store. */
export function renderEnvForSecrets(
  content: string,
  keys: string[],
  getSecretValue: (key: string) => string | undefined,
  protectedBindings: readonly (readonly [string, string])[] = []
): string {
  return renderGeneratedEnvContent(content, keys, getSecretValue, protectedBindings)
}

/**
 * Resolve credentials on each invocation so long-lived shells see rotation and detach.
 *
 * With `signingPublicKey`, agents' commits and tags are also signed: git calls
 * `ficus` as its `gpg.ssh.program`, which has Core sign with the connection's key
 * (the private half never enters the sandbox). Command-line `-c` outranks any
 * repo-local config. Signing applies only when `FICUS_TOKEN` is set, i.e. to agent
 * commands: a human terminal cannot reach the signer, and must not have every
 * commit fail.
 */
export function githubCommandBindings(squadId: string, signingPublicKey?: string): string {
  const squad = shellQuote(squadId)
  const credential = `-c credential.https://github.com.helper= -c ${shellQuote(`credential.https://github.com.helper=!f() { command ficus integration exec github --squad ${squad} -- gh auth git-credential "$@"; }; f`)}`
  const signing = signingPublicKey
    ? [
        '-c gpg.format=ssh',
        '-c commit.gpgsign=true',
        '-c tag.gpgsign=true',
        `-c ${shellQuote(`user.signingkey=key::${signingPublicKey.trim()}`)}`,
        '-c gpg.ssh.program=ficus',
      ].join(' ')
    : undefined
  const git = signing
    ? `git() { if [ -n "\${FICUS_TOKEN:-}" ]; then FICUS_GIT_SIGNING_SQUAD=${squad} command git ${credential} ${signing} "$@"; else command git ${credential} "$@"; fi; }`
    : `git() { command git ${credential} "$@"; }`
  return (
    [
      `gh() { command ficus integration exec github --squad ${squad} -- gh "$@"; }`,
      git,
      'if [ -n "${BASH_VERSION:-}" ]; then export -f gh git; fi',
    ].join('\n') + '\n'
  )
}
