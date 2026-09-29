import type { ServerInfo } from '@ficus/shared'
/**
 * `ficus whoami` — where this CLI is pointed and as whom.
 *
 * The confusion this exists to end: an agent shell, an operator terminal and a
 * laptop shell all run the same binary, and each can resolve a DIFFERENT
 * instance and a DIFFERENT credential (injected agent identity, `--backend`,
 * ambient env, the auth store, a repo `.env`). One command now answers both
 * halves: what this CLI resolved locally, and who the instance says that is.
 */

import { Command } from 'commander'
import { apiGet as defaultApiGet } from '../client'
import { output as defaultOutput, outputError } from '../output'
import { resolveAuth, type AuthSource } from '../config'

export interface WhoamiDependencies {
  apiGet: typeof defaultApiGet
  output: typeof defaultOutput
}

const defaultDependencies: WhoamiDependencies = {
  apiGet: defaultApiGet,
  output: defaultOutput,
}

/** The instance's own answer, from `/api/auth/introspect`. */
type RemoteIdentity = { type?: string; userId?: string; agentId?: string; squadId?: string | null } | null

export interface WhoamiResult {
  apiUrl: string
  source: AuthSource
  /** Auth-store label when the credential came from a stored backend. */
  label?: string
  /** The agent this shell belongs to, in agent context. */
  agentId?: string
  /** Identity variables an agent shell is missing — the state this command exists to diagnose. */
  missing?: string[]
  authenticated: boolean
  identity: RemoteIdentity
  /** Display name/email of the user behind a user identity, when the instance reports one. */
  account: string | null
  instance: { reachable: boolean; error?: string; server?: ServerInfo }
}

function describeAccount(user: { email?: string; displayName?: string }): string | null {
  if (user.displayName && user.email) return `${user.displayName} <${user.email}>`
  return user.displayName ?? user.email ?? null
}

export async function resolveWhoami(dependencies: WhoamiDependencies): Promise<WhoamiResult> {
  const { apiGet } = dependencies
  const resolved = resolveAuth()
  const local: WhoamiResult = {
    apiUrl: resolved.apiUrl,
    source: resolved.source,
    ...(resolved.label ? { label: resolved.label } : {}),
    ...(resolved.agentId ? { agentId: resolved.agentId } : {}),
    ...(resolved.missing?.length ? { missing: resolved.missing } : {}),
    authenticated: resolved.authenticated,
    identity: null,
    account: null,
    instance: { reachable: false },
  }

  // A shell with no API URL has nothing to ask; report the local resolution and
  // the missing variable rather than failing the diagnostic itself.
  if (!local.apiUrl) {
    return { ...local, instance: { reachable: false, error: `${resolved.missing?.join(' and ')} not set` } }
  }

  try {
    // The route the CLI already uses for "who am I" (`ficus auth introspect`); it
    // answers for agent tokens as well as human logins.
    const introspection = await apiGet<{ identity?: RemoteIdentity; server?: ServerInfo }>('/api/auth/introspect')
    local.identity = introspection.identity ?? null
    local.instance = { reachable: true, ...(introspection.server ? { server: introspection.server } : {}) }
  } catch (error) {
    return { ...local, instance: { reachable: false, error: (error as Error).message } }
  }

  if (local.identity?.type === 'user') {
    try {
      local.account = describeAccount(await apiGet<{ email?: string; displayName?: string }>('/api/auth/me'))
    } catch {
      // A user identity whose profile cannot be read is still a resolved identity;
      // report the identity rather than failing the whole command.
    }
  }
  return local
}

function describeSource(result: WhoamiResult): string {
  switch (result.source) {
    case 'webhook-context':
      return `webhook identity injected by Ficus${result.missing?.length ? ', incomplete' : ''}`
    case 'agent-context':
      return `agent identity injected by Ficus${result.agentId ? ` (agent ${result.agentId})` : ''}${
        result.missing?.length ? ', incomplete' : ''
      }`
    case 'selected-backend':
      return `--backend ${result.label}`
    case 'auth-store':
      return `stored backend '${result.label}'`
    case 'env-token':
      return 'FICUS_TOKEN from the environment'
    case 'env-password':
      return 'FICUS_PASSWORD from the environment'
    case 'dotenv':
      return 'FICUS_PASSWORD from a .env file'
    case 'secret-file':
      return 'the mounted sandbox password secret'
    case 'none':
      return 'no credential — not authenticated'
  }
}

export function renderWhoami(result: WhoamiResult): string {
  const lines = [`API:    ${result.apiUrl || '<not set>'}`, `Auth:   ${describeSource(result)}`]
  if (result.missing?.length) lines.push(`Missing: ${result.missing.join(', ')} — the injected identity is incomplete`)
  if (!result.instance.reachable) {
    lines.push(`Instance: did not report an identity (${result.instance.error ?? 'unreachable'})`)
    return lines.join('\n')
  }
  if (result.instance.server) {
    const server = result.instance.server
    lines.push(
      `Server: Ficus ${server.version} · API ${server.apiVersion}${server.revision ? ` · ${server.revision.slice(0, 12)}` : ''}`
    )
  }
  if (!result.identity) {
    lines.push('Instance: reachable, but reported no identity')
    return lines.join('\n')
  }
  if (result.identity.type === 'agent') {
    lines.push(
      `As:     agent ${result.identity.agentId ?? 'unknown'}${result.identity.squadId ? ` in squad ${result.identity.squadId}` : ''}`
    )
  } else if (result.identity.type === 'user') {
    lines.push(`As:     user ${result.account ?? result.identity.userId ?? 'unknown'}`)
  } else {
    lines.push(`As:     ${result.identity.type ?? 'unknown'} identity`)
  }
  return lines.join('\n')
}

export function registerWhoamiCommands(program: Command, dependencies = defaultDependencies): void {
  program
    .command('whoami')
    .description('Show which Ficus instance this CLI talks to, as whom, and where that credential came from')
    .action(async () => {
      try {
        const result = await resolveWhoami(dependencies)
        dependencies.output(result, renderWhoami(result))
      } catch (error) {
        outputError(error as Error)
      }
    })
}
