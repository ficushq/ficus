import { existsSync, readFileSync } from 'fs'
import { Command } from 'commander'
import { apiGet, apiPost, apiPut, apiDelete } from '../client'
import { output, outputError } from '../output'
import {
  formatAmtpAddress,
  parseAmtpAddress,
  type AmtpAgentCard,
  type AmtpSignedAgentCard,
  type AgentFederationStatusResponse,
  type AgentRegisterResponse,
} from '@ficus/shared'
import { readIdentityCache, writeIdentityCache, requireMatchingSigningIdentity } from '../amtp/identity'
import { buildSignedCardBody } from '../amtp/card'

type AmtpMeStatus = AgentFederationStatusResponse

/** `--ext k=v` pairs: value JSON-parsed when possible, else kept as a literal string. */
function parseExtPairs(pairs: string[] | undefined): AmtpAgentCard['extensions'] {
  if (!pairs?.length) return undefined
  const out: NonNullable<AmtpAgentCard['extensions']> = {}
  for (const p of pairs) {
    const i = p.indexOf('=')
    if (i < 1) throw new Error(`--ext expects key=value, got "${p}"`)
    const key = p.slice(0, i)
    const raw = p.slice(i + 1)
    try {
      out[key] = JSON.parse(raw)
    } catch {
      out[key] = raw
    }
  }
  return out
}

/**
 * Resolve this instance's id the same way `whoami` resolves its address fallback:
 * the cached amtp:// address (from `remote register`) first, then the operator-gated
 * instance-identity endpoint. Signing a card requires the instanceId binding (spec §4.6),
 * so unlike whoami's address (cosmetic), this one has no silent-degrade path.
 */
async function resolveInstanceId(): Promise<string> {
  const cachedAddress = readIdentityCache()?.address
  const cachedInstanceId = cachedAddress ? parseAmtpAddress(cachedAddress)?.instanceId : undefined
  if (cachedInstanceId) return cachedInstanceId
  const { instanceId } = await apiGet<{ instanceId: string }>('/api/amtp/instance-identity')
  return instanceId
}

/** A `--public-key` value may be a file path or a literal PEM string. */
export function resolvePublicKey(value: string): string {
  if (existsSync(value)) return readFileSync(value, 'utf8')
  return value
}

export function registerAmtpCommands(program: Command): void {
  const fed = program.command('amtp').description('Cross-instance federation: identity and peers')

  fed
    .command('identity')
    .description("Show this instance's federation identity (id + public key)")
    .action(async () => {
      try {
        output(await apiGet('/api/amtp/instance-identity'))
      } catch (error) {
        outputError(error as Error)
      }
    })

  const peer = fed.command('peer').description('Manage federation peers')

  peer
    .command('list')
    .description('List configured peers')
    .action(async () => {
      try {
        output(await apiGet('/api/amtp/peers'))
      } catch (error) {
        outputError(error as Error)
      }
    })

  peer
    .command('add')
    .description('Add a peer')
    .requiredOption('--alias <alias>', 'Local alias for the peer')
    .requiredOption('--instance-id <id>', "Peer's instance id (fingerprint)")
    .requiredOption('--base-url <url>', "Peer's API base URL")
    .requiredOption('--public-key <pemOrFile>', "Peer's public key (PEM string or file path)")
    .action(async (options) => {
      try {
        const created = await apiPost('/api/amtp/peers', {
          localAlias: options.alias,
          instanceId: options.instanceId,
          baseUrl: options.baseUrl,
          publicKeyPem: resolvePublicKey(options.publicKey),
        })
        output(created)
      } catch (error) {
        outputError(error as Error)
      }
    })

  peer
    .command('remove <id>')
    .description('Remove a peer')
    .action(async (id) => {
      try {
        await apiDelete(`/api/amtp/peers/${id}`)
        output({ success: true })
      } catch (error) {
        outputError(error as Error)
      }
    })
}

export function registerRemoteCommands(program: Command): void {
  const remote = program
    .command('remote')
    .description('Your agent federation identity: claim a handle, open your mailbox, list peers')

  remote
    .command('register <handle>')
    .description('Claim a federation handle so peers can address you (amtp://<instance>/<handle>)')
    .action(async (handle) => {
      try {
        const status = await apiGet<AgentFederationStatusResponse>('/api/amtp/agents/me/status')
        const local = requireMatchingSigningIdentity(status.signingIdentity.identityPublicKey)
        const res = await apiPost<AgentRegisterResponse>('/api/amtp/agents/me/register', { handle })
        const registered = requireMatchingSigningIdentity(res.identityPublicKey)
        if (local.publicKeyPem !== registered.publicKeyPem) {
          throw new Error('Registration response identity does not match the delivered signing identity.')
        }
        writeIdentityCache(res)
        output(res, `Registered as ${res.address}`)
      } catch (error) {
        outputError(error as Error)
      }
    })

  remote
    .command('open')
    .description('Open your mailbox to receive federated messages from known peers')
    .action(async () => {
      try {
        const status = await apiGet<AgentFederationStatusResponse>('/api/amtp/agents/me/status')
        requireMatchingSigningIdentity(status.signingIdentity.identityPublicKey)
        output(await apiPost('/api/amtp/agents/me/open'), 'Mailbox open')
      } catch (error) {
        outputError(error as Error)
      }
    })

  remote
    .command('close')
    .description('Close your mailbox (stop receiving federated messages)')
    .action(async () => {
      try {
        output(await apiPost('/api/amtp/agents/me/close'), 'Mailbox closed')
      } catch (error) {
        outputError(error as Error)
      }
    })

  remote
    .command('whoami')
    .description('Show your federation identity (handle, address, mailbox state, public key)')
    .action(async () => {
      try {
        const status = await apiGet<AgentFederationStatusResponse>('/api/amtp/agents/me/status')
        let localSigningIdentity: { status: 'ready' | 'unavailable'; message: string | null }
        try {
          requireMatchingSigningIdentity(status.signingIdentity.identityPublicKey)
          localSigningIdentity = { status: 'ready', message: null }
        } catch (error) {
          localSigningIdentity = { status: 'unavailable', message: (error as Error).message }
        }
        const ready = status.federationReady && localSigningIdentity.status === 'ready'
        const human = ready
          ? `Federation ready as ${status.address}; signing identity matches.`
          : status.signingIdentity.status === 'unsupported'
            ? `Federation unsupported${status.registered ? ' (registered handle retained)' : ''}: ${status.signingIdentity.message}`
            : status.registered
              ? `Registered but signing identity unavailable: ${status.signingIdentity.message ?? localSigningIdentity.message ?? status.signingIdentity.reason}. Signing operations are disabled.`
              : `Federation unavailable: ${status.signingIdentity.message ?? localSigningIdentity.message}`
        output({ ...status, federationReady: ready, localSigningIdentity }, human)
      } catch (error) {
        outputError(error as Error)
      }
    })

  remote
    .command('peers')
    .description('List federation peers configured on this instance (operator-only; valid remote targets)')
    .action(async () => {
      try {
        output(await apiGet('/api/amtp/peers'))
      } catch (error) {
        // GET /api/amtp/peers requires amtp:read, which only managers/operators have.
        // A worker agent gets a 403 — degrade gracefully (exit 0) instead of a raw
        // "Forbidden". (403 bodies are { error: 'Forbidden' }, surfaced as an Error message.)
        if (error instanceof Error && /forbidden/i.test(error.message)) {
          output(
            { peers: null, note: 'listing peers is operator-only' },
            'Listing peers is operator-only — ask an operator for the valid amtp:// targets.'
          )
          return
        }
        outputError(error as Error)
      }
    })

  remote
    .command('handles <peer>')
    .description("List a peer instance's published federation handles (peer = alias, instance id, or peer row id)")
    .action(async (peerRef) => {
      try {
        const res = await apiGet<{ handles: { handle: string; name?: string; description?: string }[] }>(
          `/api/amtp/peers/${encodeURIComponent(peerRef)}/handles`
        )
        // Resolve the peer's instanceId for copy-pasteable amtp:// addresses. `remote peers`
        // needs amtp:read; a send-only agent still gets the raw handle list.
        let instanceId: string | undefined
        try {
          const peers = await apiGet<{ id: string; localAlias: string; instanceId: string }[]>('/api/amtp/peers')
          instanceId = peers.find(
            (p) => p.id === peerRef || p.localAlias === peerRef || p.instanceId === peerRef
          )?.instanceId
        } catch {
          instanceId = undefined
        }
        const handles = res.handles.map((h) => ({
          handle: h.handle,
          ...(h.name ? { name: h.name } : {}),
          ...(h.description ? { description: h.description } : {}),
          ...(instanceId ? { address: formatAmtpAddress(instanceId, h.handle) } : {}),
        }))
        // Bare handles stay unchanged; a handle with a published name/description gets a
        // "handle — name: description" hint so peers are legible without a separate `card get`.
        const lines = handles.map((h) => {
          const hint = h.name && h.description ? `${h.name}: ${h.description}` : (h.name ?? h.description)
          return hint ? `${h.handle} — ${hint}` : h.handle
        })
        output({ handles }, lines.length > 0 ? lines.join('\n') : undefined)
      } catch (error) {
        outputError(error as Error)
      }
    })

  const card = remote.command('card').description("Publish/inspect your own agent card, or fetch a peer's (spec §4.6)")

  card
    .command('set')
    .description('Sign and publish your agent card (name/description/extensions); replaces any existing card')
    .option('--name <name>', "Display name (defaults to the agent's profile name if omitted)")
    .option('--description <text>', "Bio / who this agent is (defaults to the agent's profile description if omitted)")
    .option('--ext <kv...>', 'Extension entries key=value (value parsed as JSON when possible)')
    .action(async (options) => {
      try {
        const status = await apiGet<AmtpMeStatus>('/api/amtp/agents/me/status')
        if (!status.registered || !status.handle) {
          throw new Error('Not registered — run `ficus remote register <handle>` first.')
        }
        const name: string | undefined = options.name ?? status.agentName ?? undefined
        const description: string | undefined = options.description ?? status.agentDescription ?? undefined
        const extensions = parseExtPairs(options.ext)
        if (!name && !description && !extensions) {
          throw new Error('Nothing to publish — pass --name, --description, and/or --ext.')
        }
        const { privateKeyPem } = requireMatchingSigningIdentity(status.signingIdentity.identityPublicKey)
        const instanceId = status.address ? parseAmtpAddress(status.address)?.instanceId : await resolveInstanceId()
        if (!instanceId) throw new Error('Server federation address is unavailable.')
        const signed = buildSignedCardBody({
          instanceId,
          handle: status.handle,
          name,
          description,
          extensions,
          privateKeyPem,
        })
        const res = await apiPut<{ ok: true; card: AmtpAgentCard }>('/api/amtp/agents/me/card', signed)
        output(
          res,
          [
            `Published card for "${status.handle}".`,
            `Name: ${res.card.name ?? '(none)'}`,
            `Description: ${res.card.description ?? '(none)'}`,
          ].join('\n')
        )
      } catch (error) {
        outputError(error as Error)
      }
    })

  card
    .command('show')
    .description('Print your own published agent card')
    .action(async () => {
      try {
        const status = await apiGet<AmtpMeStatus>('/api/amtp/agents/me/status')
        if (!status.card) {
          output(
            { handle: status.handle, card: null },
            'No card published yet — run `ficus remote card set` to publish one.'
          )
          return
        }
        const { card: cardBody } = status.card
        const extCount = cardBody.extensions ? Object.keys(cardBody.extensions).length : 0
        output(
          status.card,
          [
            `Card for "${status.handle}":`,
            `Name: ${cardBody.name ?? '(none)'}`,
            `Description: ${cardBody.description ?? '(none)'}`,
            `Extensions: ${extCount}`,
          ].join('\n')
        )
      } catch (error) {
        outputError(error as Error)
      }
    })

  card
    .command('clear')
    .description('Unpublish your agent card (the handle stays registered)')
    .action(async () => {
      try {
        await apiDelete('/api/amtp/agents/me/card')
        output({ success: true }, 'Card cleared.')
      } catch (error) {
        outputError(error as Error)
      }
    })

  card
    .command('get <peer> <handle>')
    .description("Fetch and verify a peer agent's published card (TOFU-pinned signature)")
    .action(async (peerRef, handle) => {
      try {
        const res = await apiGet<{ verified: true; card: AmtpAgentCard; signedCard: AmtpSignedAgentCard }>(
          `/api/amtp/peers/${encodeURIComponent(peerRef)}/agents/${encodeURIComponent(handle)}/card`
        )
        output(
          res,
          [
            `Card for "${handle}" @ ${peerRef}:`,
            `Name: ${res.card.name ?? '(none)'}`,
            `Description: ${res.card.description ?? '(none)'}`,
            'verified (signature checked against pinned key)',
          ].join('\n')
        )
      } catch (error) {
        if (error instanceof Error && /not found/i.test(error.message)) {
          outputError(new Error(`No verified card for "${handle}" @ "${peerRef}".`))
          return
        }
        outputError(error as Error)
      }
    })
}
