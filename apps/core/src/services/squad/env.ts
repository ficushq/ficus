import { projectExecutionWrappers } from '../integrations/project-execution-wrappers'
import { join } from 'path'
import { existsSync, mkdirSync, writeFileSync, readFileSync, chmodSync, renameSync, rmSync } from 'fs'
import { loadProtectedIntegrationBindings } from '../integrations/projection/protected-env'
import { githubSigningPublicKeyForSquad } from '../integrations/github/commit-signing-store'
import { getSquadWorkspacePath } from './workspace'
import { ensureWorkspaceDotDir, prepareWorkspaceDotDir, workspaceDotPath } from '../workspace/dot-dir'
const USER_ENV_FILE = 'env.user'
const GENERATED_ENV_FILE = '.env'
const GENERATED_INTEGRATION_MARKER = '# Generated protected integration bindings. Do not edit values here.'

/**
 * Get the canonical settings directory, refusing conflicting files or symlinks.
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

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`
}

export function renderGeneratedEnvContent(
  content: string,
  protectedBindings: readonly (readonly [string, string])[] = []
): string {
  const userContent = content.trimEnd()
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
    GENERATED_INTEGRATION_MARKER,
    'unset GH_TOKEN GITHUB_TOKEN GITHUB_USER DEPLOY_GITHUB_PAGES_TOKEN',
    protectedContent,
  ]
    .filter(Boolean)
    .join('\n\n')
}

async function writeGeneratedEnvFile(squadId: string, content: string): Promise<void> {
  const ficusDir = ensureFicusDir(squadId)
  const envPath = join(ficusDir, GENERATED_ENV_FILE)
  const tempPath = join(ficusDir, `.env.tmp-${crypto.randomUUID()}`)
  let protectedBindings: readonly (readonly [string, string])[]
  let signingPublicKey: string | undefined
  try {
    protectedBindings = await loadProtectedIntegrationBindings(squadId)
    signingPublicKey = await githubSigningPublicKeyForSquad(squadId)
    await projectExecutionWrappers(squadId, join(ficusDir, 'integration-bin'), signingPublicKey)
  } catch (error) {
    rmSync(envPath, { force: true })
    throw error
  }
  try {
    writeFileSync(tempPath, renderGeneratedEnvContent(content, protectedBindings) + '\n', {
      mode: 0o600,
    })
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
  if (content.includes('# Generated from Ficus ') || content.includes(GENERATED_INTEGRATION_MARKER)) return ''
  return content
}

/**
 * Set the user-authored squad env content and regenerate the sandbox .env file.
 */
export async function setEnvFile(squadId: string, content: string): Promise<void> {
  const ficusDir = ensureFicusDir(squadId)
  const userEnvPath = join(ficusDir, USER_ENV_FILE)
  writeFileSync(userEnvPath, content, { mode: 0o600 })
  await writeGeneratedEnvFile(squadId, content)
}

/** Regenerate from custom environment content only. Errors must reach rollout retry status. */
export async function regenerateEnvFileForSquad(squadId: string): Promise<void> {
  const content = getEnvFile(squadId) ?? ''
  // Preserve pre-env.user custom configuration before replacing the generated file.
  const userPath = getUserEnvPath(squadId)
  if (!existsSync(userPath)) {
    ensureFicusDir(squadId)
    writeFileSync(userPath, content, { mode: 0o600 })
  }
  await writeGeneratedEnvFile(squadId, content)
}

// Compatibility export for existing callers; delivery lives in the executable wrapper asset.
export { githubCommandBindings } from '../integrations/github/command-bindings'
