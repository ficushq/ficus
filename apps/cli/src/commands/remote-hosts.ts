import { Command } from 'commander'
import { apiDelete, apiGet, apiPost } from '../client'
import { isJsonMode, output, outputError, outputTable } from '../output'

/**
 * `ficus remote-hosts`: the agent-facing CLI for the team-owned SSH registry
 * (docs/history/superpowers/specs/2026-07-14-remote-hosts-design.md § CLI). Mirrors
 * `commands/secret.ts` for structure and `commands/amtp.ts` for the
 * multi-word-group idiom (`ficus remote` is taken by federation, hence
 * `remote-hosts`).
 */

/** Public shape returned by every remote-hosts route — never carries key material. */
export interface PublicRemoteHost {
  id: string
  name: string
  description?: string | null
  sshHost: string
  sshPort: number
  sshUser: string
  sshPublicKey: string
  createdAt: string
  updatedAt: string
  squadIds?: string[]
  hostKeyState?: HostKeyState
  hostKeys?: PublicHostKey[]
  hostKeyCheckError?: string | null
  fetchError?: string
}

/** See Core's `remote-hosts/host-keys.ts` for what each state means. */
export type HostKeyState = 'adopting' | 'trusted' | 'changed' | 'pending' | 'unverified'

/** A host's SSH host key as the API returns it: fingerprint only. */
export interface PublicHostKey {
  id: string
  keyType: string
  fingerprint: string
  status: string
  origin: string
  decisionNote: string | null
  decidedByUserId: string | null
  decidedAt: string | null
  replacesFingerprints: string[]
}

/** A box whose own known_hosts pins a different key than a Core-managed entry. */
export interface KnownHostsConflict {
  id: string
  sandboxId: string
  host: string
  keyType: string
  boxFingerprint: string
  coreFingerprint: string
  boxLine: number
  wildcard: boolean
  status: string
  resolvedByUserId: string | null
}

const STATE_SUMMARY: Record<HostKeyState, string> = {
  trusted: 'host key trusted; connections are checked strictly against it',
  adopting: 'adopting the key boxes already trust; connections use strict checking meanwhile',
  changed: 'HOST KEY CHANGED: connections are refused until a person trusts or rejects the new key',
  pending: 'BLOCKED: a person must confirm the host key before agents can connect',
  unverified: 'BLOCKED: no host key to confirm yet; fetch it, then a person must trust it',
}

/**
 * The host-key screen for one host: state, every key with its fingerprint and
 * decision, and how to act. Pure and exported for tests.
 */
export function renderHostKeys(host: PublicRemoteHost): string {
  const state = host.hostKeyState ?? 'unverified'
  const lines = [`${host.name}: ${STATE_SUMMARY[state]}`]
  const fetchError = host.fetchError ?? host.hostKeyCheckError
  if (fetchError) lines.push(`Last key fetch failed: ${fetchError}`)
  const keys = host.hostKeys ?? []
  if (!keys.length) lines.push('No host keys recorded.')
  for (const key of keys) {
    const decided = key.decidedAt
      ? ` — ${key.decisionNote ?? key.status}${key.decidedByUserId ? ` (user ${key.decidedByUserId})` : ''}, ${key.decidedAt}`
      : ''
    lines.push(`  [${key.status}] ${key.keyType} ${key.fingerprint}${decided}`)
    if (key.status === 'pending' && key.replacesFingerprints.length) {
      lines.push(`      key change: replaces trusted ${key.replacesFingerprints.join(', ')}`)
    }
  }
  if (keys.some((k) => k.status === 'pending')) {
    lines.push(
      '',
      'Only a person can trust or reject a key (agents are refused). Compare the fingerprint with one obtained',
      'out of band (for example `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` on the host), then:',
      `  ficus remote-hosts trust-key ${host.name} <fingerprint>    or    ficus remote-hosts reject-key ${host.name} <fingerprint>`
    )
  } else if (state === 'unverified') {
    lines.push('', `Fetch the key with: ficus remote-hosts fetch-key ${host.name}`)
  }
  return lines.join('\n')
}

/** Box known_hosts conflicts for a squad. Pure and exported for tests. */
export function renderConflicts(conflicts: KnownHostsConflict[]): string {
  if (!conflicts.length) return 'No known_hosts conflicts on your squad boxes.'
  const lines = ['Known_hosts conflicts (a box pins a different key than Ficus manages for the host):']
  for (const c of conflicts) {
    lines.push(
      `  ${c.id} [${c.status}] ${c.host} ${c.keyType} on ${c.sandboxId} line ${c.boxLine}${c.wildcard ? ' (wildcard line)' : ''}`,
      `      box:  ${c.boxFingerprint}`,
      `      Ficus: ${c.coreFingerprint}`
    )
  }
  if (conflicts.some((c) => c.status === 'open')) {
    lines.push(
      '',
      'Only a person can resolve a conflict: ficus remote-hosts resolve-conflict <id> --keep-box | --use-core',
      '(--use-core is refused for a wildcard line; edit that line by hand or keep the box key.)'
    )
  }
  return lines.join('\n')
}

interface SyncResult {
  pushed: boolean
  reason?: string
}

interface CheckResult {
  reachable: boolean
  error?: string
}

const LIST_COLUMNS = ['name', 'sshUser', 'sshHost', 'sshPort', 'hostKeyState', 'description']

/**
 * The "finish setup" block printed after `add` and re-printed by `show`: the
 * public key to install, plus plain-language instructions for the human who
 * owns the target box. Pure and exported so it's testable without hitting
 * the API.
 */
export function renderInstallInstructions(
  host: Pick<PublicRemoteHost, 'name' | 'sshHost' | 'sshUser' | 'sshPublicKey'>
): string {
  return [
    host.sshPublicKey.trim(),
    `Ask the owner of ${host.sshHost} to append the line above to ~/.ssh/authorized_keys for user ${host.sshUser}.`,
    `Then verify with: ficus remote-hosts check ${host.name}.`,
  ].join('\n')
}

/**
 * Result of a revoke call. Revoke now ROTATES the host key server-side
 * (spec §7), so the response carries the new public key + operator guidance
 * (or a warning if rotation failed). Optional-everything so a legacy/no-body
 * response still renders cleanly.
 */
export interface RevokeResult {
  rotated?: boolean
  sshPublicKey?: string
  message?: string
  warning?: string
}

/**
 * Render the human-readable revoke output. On a successful rotation it prints
 * the new public key (which the operator must install on the host) plus the
 * server's authorized_keys guidance; on a failed rotation it surfaces the
 * warning. Pure and exported so it's testable without hitting the API.
 */
export function renderRevokeMessage(headline: string, result?: RevokeResult): string {
  const lines = [headline]
  if (result?.rotated && result.sshPublicKey) {
    lines.push('', 'The host key was rotated — install the NEW public key on the host:', result.sshPublicKey.trim())
    if (result.message) lines.push(result.message)
  } else if (result?.rotated === false && result.warning) {
    lines.push('', result.warning)
  }
  return lines.join('\n')
}

const PORT_RE = /^\d+$/

/**
 * Validate a `--port` value client-side (mirrors the server's
 * `z.number().int().min(1).max(65535)` schema) so a malformed port is
 * rejected with a friendly message before any API call, instead of a raw
 * 400 from the server.
 */
function validatePort(port: string): number {
  const n = Number(port)
  if (!PORT_RE.test(port) || n < 1 || n > 65535) {
    throw new Error(`Invalid --port "${port}": must be a whole number between 1 and 65535.`)
  }
  return n
}

/** Resolve the squad to act as: `--squad` wins, else `FICUS_SQUAD_ID` (set automatically inside a squad box). */
function resolveSquadId(explicit?: string): string {
  const squadId = explicit ?? process.env.FICUS_SQUAD_ID
  if (!squadId) {
    throw new Error(
      'No squad context: run this from a squad agent box (FICUS_SQUAD_ID is set automatically) or pass --squad <id>.'
    )
  }
  return squadId
}

function fetchGlobalHosts(): Promise<PublicRemoteHost[]> {
  return apiGet<PublicRemoteHost[]>('/api/remote-hosts')
}

function fetchSquadHosts(squadId: string): Promise<PublicRemoteHost[]> {
  return apiGet<PublicRemoteHost[]>(`/api/remote-hosts/squad/${encodeURIComponent(squadId)}`)
}

function findByName(hosts: PublicRemoteHost[], name: string): PublicRemoteHost {
  const host = hosts.find((h) => h.name === name)
  if (!host) throw new Error(`Remote host "${name}" not found.`)
  return host
}

function describeHost(host: PublicRemoteHost): string {
  return `${host.name}: ${host.sshUser}@${host.sshHost}:${host.sshPort}`
}

/** Resolve a host for a host-key command: the global registry with --all, else the squad surface. */
async function resolveHostForKeys(
  name: string,
  opts: { all?: boolean; squad?: string }
): Promise<{ host: PublicRemoteHost; base: string }> {
  if (opts.all) {
    const host = findByName(await fetchGlobalHosts(), name)
    return { host, base: `/api/remote-hosts/${host.id}/host-keys` }
  }
  const squadId = resolveSquadId(opts.squad)
  const host = findByName(await fetchSquadHosts(squadId), name)
  return { host, base: `/api/remote-hosts/squad/${encodeURIComponent(squadId)}/host-keys/${host.id}` }
}

function findKey(host: PublicRemoteHost, fingerprintOrId: string): PublicHostKey {
  const key = (host.hostKeys ?? []).find((k) => k.fingerprint === fingerprintOrId || k.id === fingerprintOrId)
  if (!key) {
    throw new Error(`No host key ${fingerprintOrId} on "${host.name}". See: ficus remote-hosts host-keys ${host.name}`)
  }
  return key
}

export function registerRemoteHostsCommands(program: Command) {
  const remoteHosts = program.command('remote-hosts').description('Manage team-owned SSH remote hosts')

  // ficus remote-hosts list [--all] [--squad <id>]
  remoteHosts
    .command('list')
    .description('List remote hosts (defaults to your squad; --all for the whole registry)')
    .option('--all', 'list the whole registry (needs global remote-hosts:read)')
    .option('--squad <id>', 'list hosts granted to a specific squad instead of your own')
    .action(async (opts: { all?: boolean; squad?: string }) => {
      try {
        const hosts = opts.all ? await fetchGlobalHosts() : await fetchSquadHosts(resolveSquadId(opts.squad))
        if (isJsonMode()) {
          output(hosts)
        } else if (hosts.length === 0) {
          console.log('No remote hosts found')
        } else {
          outputTable(hosts, LIST_COLUMNS)
        }
      } catch (error) {
        outputError(error as Error)
      }
    })

  // ficus remote-hosts show <name> [--all] [--squad <id>]
  remoteHosts
    .command('show <name>')
    .description('Show a remote host and its install instructions')
    .option('--all', 'resolve from the whole registry instead of your squad')
    .option('--squad <id>', 'resolve from a specific squad instead of your own')
    .action(async (name: string, opts: { all?: boolean; squad?: string }) => {
      try {
        const hosts = opts.all ? await fetchGlobalHosts() : await fetchSquadHosts(resolveSquadId(opts.squad))
        const host = findByName(hosts, name)
        const lines = [
          describeHost(host),
          ...(host.description ? [host.description] : []),
          '',
          renderInstallInstructions(host),
          ...(host.hostKeyState ? ['', renderHostKeys(host)] : []),
        ]
        output(host, lines.join('\n'))
      } catch (error) {
        outputError(error as Error)
      }
    })

  // ficus remote-hosts add --name <n> --host <h> --user <u> [--port <p>] [--description <d>] [--squad <id>] [--global]
  remoteHosts
    .command('add')
    .description('Register a new remote host (grants it to your squad unless --global)')
    .requiredOption('--name <name>', 'ssh alias')
    .requiredOption('--host <host>', 'ssh hostname/address')
    .requiredOption('--user <user>', 'ssh user')
    .option('--port <port>', 'ssh port (default 22)')
    .option('--description <description>', 'free-text description')
    .option('--squad <id>', 'grant to this squad instead of FICUS_SQUAD_ID')
    .option('--global', 'register without granting any squad (needs global remote-hosts:write)')
    .action(
      async (opts: {
        name: string
        host: string
        user: string
        port?: string
        description?: string
        squad?: string
        global?: boolean
      }) => {
        try {
          const body = {
            name: opts.name,
            sshHost: opts.host,
            sshUser: opts.user,
            ...(opts.port !== undefined ? { sshPort: validatePort(opts.port) } : {}),
            ...(opts.description !== undefined ? { description: opts.description } : {}),
          }
          const host = opts.global
            ? await apiPost<PublicRemoteHost>('/api/remote-hosts', body)
            : await apiPost<PublicRemoteHost>(
                `/api/remote-hosts/squad/${encodeURIComponent(resolveSquadId(opts.squad))}`,
                body
              )

          const lines = [
            `Registered "${host.name}" (${host.sshUser}@${host.sshHost}:${host.sshPort}).`,
            '',
            renderInstallInstructions(host),
            ...(host.hostKeyState ? ['', renderHostKeys(host)] : []),
          ]
          output(host, lines.join('\n'))
        } catch (error) {
          outputError(error as Error)
        }
      }
    )

  // ficus remote-hosts grant <name> --squad <id>
  remoteHosts
    .command('grant <name>')
    .description('Grant a squad access to a remote host (global write)')
    .requiredOption('--squad <id>', 'squad to grant access to')
    .action(async (name: string, opts: { squad: string }) => {
      try {
        const host = findByName(await fetchGlobalHosts(), name)
        await apiPost(`/api/remote-hosts/${host.id}/grants`, { squadId: opts.squad })
        output(
          { host: host.name, squadId: opts.squad, granted: true },
          `Granted "${host.name}" to squad ${opts.squad}.`
        )
      } catch (error) {
        outputError(error as Error)
      }
    })

  // ficus remote-hosts revoke <name> [--squad <id>]
  remoteHosts
    .command('revoke <name>')
    .description("Revoke a squad's access to a remote host (defaults to your own squad)")
    .option('--squad <id>', "revoke a different squad's grant instead (global write)")
    .action(async (name: string, opts: { squad?: string }) => {
      try {
        if (opts.squad) {
          const host = findByName(await fetchGlobalHosts(), name)
          const result = await apiDelete<RevokeResult>(
            `/api/remote-hosts/${host.id}/grants/${encodeURIComponent(opts.squad)}`
          )
          output(
            { host: host.name, squadId: opts.squad, revoked: true, ...result },
            renderRevokeMessage(`Revoked squad ${opts.squad}'s access to "${host.name}".`, result)
          )
        } else {
          const squadId = resolveSquadId()
          const host = findByName(await fetchSquadHosts(squadId), name)
          const result = await apiDelete<RevokeResult>(
            `/api/remote-hosts/squad/${encodeURIComponent(squadId)}/${host.id}`
          )
          output(
            { host: host.name, squadId, revoked: true, ...result },
            renderRevokeMessage(`Revoked your squad's access to "${host.name}".`, result)
          )
        }
      } catch (error) {
        outputError(error as Error)
      }
    })

  // ficus remote-hosts remove <name>
  remoteHosts
    .command('remove <name>')
    .description('Delete a remote host entirely (global write)')
    .action(async (name: string) => {
      try {
        const host = findByName(await fetchGlobalHosts(), name)
        try {
          await apiDelete(`/api/remote-hosts/${host.id}`)
        } catch (error) {
          if (error instanceof Error && /not found/i.test(error.message)) {
            throw new Error(`Remote host "${name}" not found.`)
          }
          throw error
        }
        output({ name, deleted: true }, `Deleted remote host "${name}".`)
      } catch (error) {
        outputError(error as Error)
      }
    })

  // ficus remote-hosts check <name> [--all] [--squad <id>]
  remoteHosts
    .command('check <name>')
    .description('Probe SSH connectivity to a remote host (squad surface by default; --all for the global registry)')
    .option('--all', 'check via the global registry instead of your squad (needs global remote-hosts:write)')
    .option('--squad <id>', 'check a host granted to a specific squad instead of your own')
    .action(async (name: string, opts: { all?: boolean; squad?: string }) => {
      try {
        let result: CheckResult
        if (opts.all) {
          const host = findByName(await fetchGlobalHosts(), name)
          result = await apiPost<CheckResult>(`/api/remote-hosts/${host.id}/check`)
        } else {
          const squadId = resolveSquadId(opts.squad)
          const host = findByName(await fetchSquadHosts(squadId), name)
          result = await apiPost<CheckResult>(`/api/remote-hosts/squad/${encodeURIComponent(squadId)}/check/${host.id}`)
        }
        if (result.reachable) {
          output(result, `"${name}" is reachable.`)
        } else {
          output(result, `"${name}" is NOT reachable: ${result.error ?? 'unknown error'}`)
        }
      } catch (error) {
        outputError(error as Error)
      }
    })

  // ficus remote-hosts host-keys <name> [--all] [--squad <id>]
  remoteHosts
    .command('host-keys <name>')
    .description("Show a remote host's SSH host keys and whether agents can connect")
    .option('--all', 'resolve from the whole registry instead of your squad')
    .option('--squad <id>', 'resolve from a specific squad instead of your own')
    .action(async (name: string, opts: { all?: boolean; squad?: string }) => {
      try {
        const { host } = await resolveHostForKeys(name, opts)
        output(host, renderHostKeys(host))
      } catch (error) {
        outputError(error as Error)
      }
    })

  // ficus remote-hosts fetch-key <name> [--all] [--squad <id>]
  remoteHosts
    .command('fetch-key <name>')
    .description("Fetch a remote host's SSH host keys (no login); new keys wait for a person to confirm")
    .option('--all', 'use the global registry (needs global remote-hosts:write)')
    .option('--squad <id>', 'a host granted to a specific squad instead of your own')
    .action(async (name: string, opts: { all?: boolean; squad?: string }) => {
      try {
        const { base } = await resolveHostForKeys(name, opts)
        const host = await apiPost<PublicRemoteHost>(`${base}/scan`)
        output(host, renderHostKeys(host))
      } catch (error) {
        outputError(error as Error)
      }
    })

  // ficus remote-hosts trust-key|reject-key <name> <fingerprint> [--all] [--squad <id>]
  for (const [command, action, verb] of [
    ['trust-key', 'trust', 'Trust'],
    ['reject-key', 'reject', 'Reject'],
  ] as const) {
    remoteHosts
      .command(`${command} <name> <fingerprint>`)
      .description(`${verb} a fetched SSH host key (people only; agents are refused)`)
      .option('--all', 'use the global registry (needs global remote-hosts:write)')
      .option('--squad <id>', 'a host granted to a specific squad instead of your own')
      .action(async (name: string, fingerprint: string, opts: { all?: boolean; squad?: string }) => {
        try {
          const { host, base } = await resolveHostForKeys(name, opts)
          const key = findKey(host, fingerprint)
          const updated = await apiPost<PublicRemoteHost>(`${base}/${key.id}/${action}`)
          output(updated, renderHostKeys(updated))
        } catch (error) {
          outputError(error as Error)
        }
      })
  }

  // ficus remote-hosts conflicts [--squad <id>]
  remoteHosts
    .command('conflicts')
    .description("Show known_hosts conflicts on your squad's boxes (a box pins a different key than Ficus)")
    .option('--squad <id>', 'a specific squad instead of your own')
    .action(async (opts: { squad?: string }) => {
      try {
        const squadId = resolveSquadId(opts.squad)
        const conflicts = await apiGet<KnownHostsConflict[]>(
          `/api/remote-hosts/squad/${encodeURIComponent(squadId)}/known-hosts-conflicts`
        )
        output(conflicts, renderConflicts(conflicts))
      } catch (error) {
        outputError(error as Error)
      }
    })

  // ficus remote-hosts resolve-conflict <id> --keep-box|--use-core [--squad <id>]
  remoteHosts
    .command('resolve-conflict <id>')
    .description('Resolve a known_hosts conflict (people only; agents are refused)')
    .option('--keep-box', "keep the box's key and stop reporting this exact pair")
    .option('--use-core', "replace the box's conflicting line(s) with the key Ficus manages")
    .option('--squad <id>', 'a specific squad instead of your own')
    .action(async (id: string, opts: { keepBox?: boolean; useCore?: boolean; squad?: string }) => {
      try {
        if (Boolean(opts.keepBox) === Boolean(opts.useCore))
          throw new Error('Pass exactly one of --keep-box or --use-core.')
        const squadId = resolveSquadId(opts.squad)
        const choice = opts.keepBox ? 'keep-box' : 'use-core'
        const result = await apiPost<KnownHostsConflict>(
          `/api/remote-hosts/squad/${encodeURIComponent(squadId)}/known-hosts-conflicts/${encodeURIComponent(id)}/${choice}`
        )
        output(result, `Conflict ${id} resolved (${choice === 'keep-box' ? 'box key kept' : 'Ficus key applied'}).`)
      } catch (error) {
        outputError(error as Error)
      }
    })

  // ficus remote-hosts sync
  remoteHosts
    .command('sync')
    .description('Re-push your squad ssh config/keys to your box now')
    .action(async () => {
      try {
        const squadId = resolveSquadId()
        const result = await apiPost<SyncResult>(`/api/remote-hosts/squad/${encodeURIComponent(squadId)}/sync`)
        if (result.pushed) {
          output(result, 'Synced ssh config and keys to your box.')
        } else if (result.reason === 'live-mount') {
          output(result, "No sync needed: your box mounts the squad's ssh config live, so changes already apply.")
        } else if (result.reason === 'box-unreachable') {
          output(result, "Your box isn't reachable right now — try `ficus remote-hosts sync` again once it wakes.")
        } else {
          output(result, `Not pushed (${result.reason ?? 'unknown reason'}).`)
        }
      } catch (error) {
        outputError(error as Error)
      }
    })
}
