import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { generateKeyPairSync } from 'crypto'
import { Command } from 'commander'
import { verifyAgentCard } from 'amtp-protocol'
import { apiGet, apiPost, apiPut, apiDelete } from '../client'
import { output, outputError } from '../output'
import { resolvePublicKey, registerRemoteCommands } from './amtp'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'fed-cli-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('resolvePublicKey', () => {
  test('returns file contents when the value is a readable path', async () => {
    const p = join(dir, 'key.pem')
    await writeFile(p, 'PEMDATA')
    expect(resolvePublicKey(p)).toBe('PEMDATA')
  })
  test('returns the literal when not a path', () => {
    expect(resolvePublicKey('-----BEGIN PUBLIC KEY-----')).toBe('-----BEGIN PUBLIC KEY-----')
  })
})

describe('ficus remote commands', () => {
  let publicPem: string
  let privatePem: string
  beforeEach(async () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519')
    publicPem = publicKey.export({ type: 'spki', format: 'pem' }) as string
    process.env.FICUS_IDENTITY_PEM = join(dir, 'identity.pem')
    privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string
    await writeFile(process.env.FICUS_IDENTITY_PEM, privatePem)
    process.env.FICUS_IDENTITY_CACHE = join(dir, 'identity.json')
    ;(output as ReturnType<typeof mock>).mockClear()
    ;(outputError as ReturnType<typeof mock>).mockClear()
    ;(apiPost as ReturnType<typeof mock>).mockClear()
    ;(apiPost as ReturnType<typeof mock>).mockResolvedValue({
      handle: 'alice',
      address: 'amtp://inst/alice',
      identityPublicKey: publicPem,
    })
    ;(apiGet as ReturnType<typeof mock>).mockClear()
    ;(apiGet as ReturnType<typeof mock>).mockResolvedValue({
      handle: 'alice',
      registered: true,
      inboundOpen: false,
      allowsInbound: false,
      allowRules: [],
      address: 'amtp://inst/alice',
      federationReady: true,
      signingIdentity: { status: 'ready', reason: null, message: null, identityPublicKey: publicPem },
      card: null,
      agentName: null,
      agentDescription: null,
    })
  })
  afterEach(() => {
    delete process.env.FICUS_IDENTITY_CACHE
    delete process.env.FICUS_IDENTITY_PEM
  })

  async function run(args: string[]): Promise<void> {
    const program = new Command()
    program.exitOverride()
    registerRemoteCommands(program)
    await program.parseAsync(args, { from: 'user' })
  }

  test('register posts the handle to the me/register route', async () => {
    await run(['remote', 'register', 'alice'])
    expect(apiPost).toHaveBeenCalledWith('/api/amtp/agents/me/register', { handle: 'alice' })
  })
  test('register fails before POST or cache write when the local PEM is missing', async () => {
    await rm(process.env.FICUS_IDENTITY_PEM!)
    await run(['remote', 'register', 'alice'])
    expect(apiPost).not.toHaveBeenCalled()
    expect(outputError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringMatching(/not found/) }))
  })

  test('register fails before POST when the server signing identity is unavailable', async () => {
    ;(apiGet as ReturnType<typeof mock>).mockResolvedValueOnce({
      signingIdentity: {
        status: 'unavailable',
        reason: 'missing_public_key',
        message: 'Not provisioned.',
        identityPublicKey: null,
      },
    })
    await run(['remote', 'register', 'alice'])
    expect(apiPost).not.toHaveBeenCalled()
    expect(outputError).toHaveBeenCalled()
  })

  test('register rejects mixed-version null and mismatched responses without caching', async () => {
    for (const identityPublicKey of [
      null,
      generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }),
    ]) {
      ;(apiPost as ReturnType<typeof mock>).mockClear()
      ;(apiPost as ReturnType<typeof mock>).mockResolvedValueOnce({
        handle: 'alice',
        address: 'amtp://inst/alice',
        identityPublicKey,
      })
      await run(['remote', 'register', 'alice'])
      expect(existsSync(process.env.FICUS_IDENTITY_CACHE!)).toBe(false)
    }
  })

  test('open posts to me/open', async () => {
    await run(['remote', 'open'])
    expect(apiPost).toHaveBeenCalledWith('/api/amtp/agents/me/open')
  })
  test('open fails before POST when the local key mismatches', async () => {
    await writeFile(
      process.env.FICUS_IDENTITY_PEM!,
      generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }) as string
    )
    ;(apiPost as ReturnType<typeof mock>).mockClear()
    await run(['remote', 'open'])
    expect(apiPost).not.toHaveBeenCalled()
  })

  test('close posts to me/close', async () => {
    await run(['remote', 'close'])
    expect(apiPost).toHaveBeenCalledWith('/api/amtp/agents/me/close')
  })
  test('whoami reads live status from me/status', async () => {
    await run(['remote', 'whoami'])
    expect(apiGet).toHaveBeenCalledWith('/api/amtp/agents/me/status')
  })
  test('whoami exposes historical unavailable server and local state', async () => {
    ;(apiGet as ReturnType<typeof mock>).mockResolvedValueOnce({
      handle: 'legacy',
      address: 'amtp://inst/legacy',
      registered: true,
      federationReady: false,
      inboundOpen: false,
      allowsInbound: false,
      allowRules: [],
      card: null,
      agentName: null,
      agentDescription: null,
      signingIdentity: {
        status: 'unavailable',
        reason: 'missing_private_key',
        message: 'Canonical private key is missing.',
        identityPublicKey: publicPem,
      },
    })
    await rm(process.env.FICUS_IDENTITY_PEM!)
    await run(['remote', 'whoami'])
    expect(output).toHaveBeenCalledWith(
      expect.objectContaining({
        signingIdentity: expect.objectContaining({ reason: 'missing_private_key' }),
        localSigningIdentity: expect.objectContaining({ status: 'unavailable' }),
        federationReady: false,
      }),
      expect.stringMatching(/Registered but signing identity unavailable: Canonical private key is missing/)
    )
  })

  test('whoami prioritizes unsupported shared custody for a retained historical handle', async () => {
    ;(apiGet as ReturnType<typeof mock>).mockResolvedValueOnce({
      handle: 'legacy',
      address: 'amtp://inst/legacy',
      registered: true,
      federationReady: false,
      inboundOpen: false,
      allowsInbound: false,
      allowRules: [],
      card: null,
      agentName: null,
      agentDescription: null,
      signingIdentity: {
        status: 'unsupported',
        reason: 'shared_system_manager_custody',
        message: 'Private storage is shared.',
        identityPublicKey: null,
      },
    })
    await run(['remote', 'whoami'])
    expect(output).toHaveBeenCalledWith(
      expect.objectContaining({ federationReady: false, localSigningIdentity: expect.any(Object) }),
      expect.stringMatching(/Federation unsupported.*registered handle retained.*shared/i)
    )
  })

  test('peers lists configured peers', async () => {
    await run(['remote', 'peers'])
    expect(apiGet).toHaveBeenCalledWith('/api/amtp/peers')
  })
  test('peers degrades gracefully on a 403 (operator-only), not a raw Forbidden', async () => {
    // Worker/consultant agents lack amtp:read → the route 403s. The command must resolve
    // (exit 0) rather than calling outputError (which would process.exit(1)).
    ;(apiGet as ReturnType<typeof mock>).mockRejectedValueOnce(new Error('Forbidden'))
    await expect(run(['remote', 'peers'])).resolves.toBeUndefined()
    expect(apiGet).toHaveBeenCalledWith('/api/amtp/peers')
  })
})

describe('remote handles command', () => {
  test('registers the handles subcommand with a required peer argument', () => {
    const program = new Command()
    program.exitOverride()
    registerRemoteCommands(program)
    const remote = program.commands.find((c) => c.name() === 'remote')
    const handles = remote?.commands.find((c) => c.name() === 'handles')
    expect(handles).toBeDefined()
    expect(handles?.registeredArguments.map((a) => a.name())).toEqual(['peer'])
  })

  test('fetches the peer handle list', async () => {
    ;(apiGet as ReturnType<typeof mock>).mockClear()
    ;(apiGet as ReturnType<typeof mock>).mockImplementation((path: string) => {
      if (path.endsWith('/handles')) {
        return Promise.resolve({
          handles: [{ handle: 'alice', name: 'Alice', description: 'Support bot' }, { handle: 'bob' }],
        })
      }
      return Promise.resolve([])
    })
    const program = new Command()
    program.exitOverride()
    registerRemoteCommands(program)
    await program.parseAsync(['remote', 'handles', 'peer-1'], { from: 'user' })
    expect(apiGet).toHaveBeenCalledWith('/api/amtp/peers/peer-1/handles')
  })
})

describe('ficus remote card commands', () => {
  let dir: string
  let priv: string
  let pub: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'fed-card-cli-'))
    const { publicKey, privateKey } = generateKeyPairSync('ed25519')
    priv = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string
    pub = publicKey.export({ type: 'spki', format: 'pem' }) as string
    process.env.FICUS_IDENTITY_PEM = join(dir, 'identity.pem')
    process.env.FICUS_IDENTITY_CACHE = join(dir, 'identity.json')
    await writeFile(process.env.FICUS_IDENTITY_PEM, priv)
    ;(apiGet as ReturnType<typeof mock>).mockReset()
    ;(apiPut as ReturnType<typeof mock>).mockReset()
    ;(apiDelete as ReturnType<typeof mock>).mockReset()
    ;(outputError as ReturnType<typeof mock>).mockClear()
  })
  afterEach(async () => {
    delete process.env.FICUS_IDENTITY_PEM
    delete process.env.FICUS_IDENTITY_CACHE
    await rm(dir, { recursive: true, force: true })
  })

  async function run(args: string[]): Promise<void> {
    const program = new Command()
    program.exitOverride()
    registerRemoteCommands(program)
    await program.parseAsync(args, { from: 'user' })
  }

  test('card set signs a card from flags and PUTs it, instanceId resolved from the cached address', async () => {
    await writeFile(
      process.env.FICUS_IDENTITY_CACHE!,
      JSON.stringify({ handle: 'alice', address: 'amtp://inst-1/alice', identityPublicKey: pub })
    )
    ;(apiGet as ReturnType<typeof mock>).mockResolvedValue({
      handle: 'alice',
      registered: true,
      inboundOpen: false,
      allowsInbound: false,
      allowRules: [],
      address: 'amtp://inst-1/alice',
      federationReady: true,
      signingIdentity: { status: 'ready', reason: null, message: null, identityPublicKey: pub },
      card: null,
      agentName: null,
      agentDescription: null,
    })
    ;(apiPut as ReturnType<typeof mock>).mockImplementation((_path: string, body: unknown) =>
      Promise.resolve({ ok: true, card: (body as { card: unknown }).card })
    )

    await run(['remote', 'card', 'set', '--name', 'Alice', '--description', 'A helpful agent'])

    expect(apiPut).toHaveBeenCalledTimes(1)
    const [path, body] = (apiPut as ReturnType<typeof mock>).mock.calls[0] as [string, Record<string, unknown>]
    expect(path).toBe('/api/amtp/agents/me/card')
    expect(body.instanceId).toBe('inst-1')
    expect(body.handle).toBe('alice')
    expect(body.card).toEqual({ name: 'Alice', description: 'A helpful agent' })
    expect(verifyAgentCard(pub, body as never)).toBe(true)
    // instanceId came from the cache, not a fallback fetch of instance-identity.
    expect(apiGet).not.toHaveBeenCalledWith('/api/amtp/instance-identity')
  })

  test('card set defaults name/description from status when flags are omitted', async () => {
    await writeFile(
      process.env.FICUS_IDENTITY_CACHE!,
      JSON.stringify({ handle: 'alice', address: 'amtp://inst-1/alice', identityPublicKey: pub })
    )
    ;(apiGet as ReturnType<typeof mock>).mockResolvedValue({
      handle: 'alice',
      registered: true,
      inboundOpen: false,
      allowsInbound: false,
      allowRules: [],
      address: 'amtp://inst-1/alice',
      federationReady: true,
      signingIdentity: { status: 'ready', reason: null, message: null, identityPublicKey: pub },
      card: null,
      agentName: 'Old Name',
      agentDescription: 'Old bio',
    })
    ;(apiPut as ReturnType<typeof mock>).mockImplementation((_path: string, body: unknown) =>
      Promise.resolve({ ok: true, card: (body as { card: unknown }).card })
    )

    await run(['remote', 'card', 'set'])

    const [, body] = (apiPut as ReturnType<typeof mock>).mock.calls[0] as [string, Record<string, unknown>]
    expect(body.card).toEqual({ name: 'Old Name', description: 'Old bio' })
  })

  test('card set refuses to publish before the handle is registered', async () => {
    ;(apiGet as ReturnType<typeof mock>).mockResolvedValue({
      handle: null,
      registered: false,
      inboundOpen: false,
      allowsInbound: false,
      allowRules: [],
      address: 'amtp://inst-1/alice',
      federationReady: true,
      signingIdentity: { status: 'ready', reason: null, message: null, identityPublicKey: pub },
      card: null,
      agentName: null,
      agentDescription: null,
    })

    await run(['remote', 'card', 'set', '--name', 'Alice'])

    expect(apiPut).not.toHaveBeenCalled()
    expect(outputError).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringMatching(/not registered/i) })
    )
  })

  test('card set fails before PUT when the delivered PEM is missing', async () => {
    await rm(process.env.FICUS_IDENTITY_PEM!)
    ;(apiGet as ReturnType<typeof mock>).mockResolvedValue({
      handle: 'alice',
      address: 'amtp://inst-1/alice',
      registered: true,
      federationReady: true,
      inboundOpen: false,
      allowsInbound: false,
      allowRules: [],
      card: null,
      agentName: 'Alice',
      agentDescription: null,
      signingIdentity: { status: 'ready', reason: null, message: null, identityPublicKey: pub },
    })
    await run(['remote', 'card', 'set'])
    expect(apiPut).not.toHaveBeenCalled()
  })

  test('card set refuses to publish an empty card', async () => {
    ;(apiGet as ReturnType<typeof mock>).mockResolvedValue({
      handle: 'alice',
      registered: true,
      inboundOpen: false,
      allowsInbound: false,
      allowRules: [],
      address: 'amtp://inst-1/alice',
      federationReady: true,
      signingIdentity: { status: 'ready', reason: null, message: null, identityPublicKey: pub },
      card: null,
      agentName: null,
      agentDescription: null,
    })

    await run(['remote', 'card', 'set'])

    expect(apiPut).not.toHaveBeenCalled()
    expect(outputError).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringMatching(/nothing to publish/i) })
    )
  })

  test('card show reports no card published when status.card is null', async () => {
    ;(apiGet as ReturnType<typeof mock>).mockResolvedValue({
      handle: 'alice',
      registered: true,
      inboundOpen: false,
      allowsInbound: false,
      allowRules: [],
      address: 'amtp://inst-1/alice',
      federationReady: true,
      signingIdentity: { status: 'ready', reason: null, message: null, identityPublicKey: pub },
      card: null,
      agentName: null,
      agentDescription: null,
    })

    await run(['remote', 'card', 'show'])

    expect(apiGet).toHaveBeenCalledWith('/api/amtp/agents/me/status')
    expect(outputError).not.toHaveBeenCalled()
  })

  test('card clear DELETEs the published card', async () => {
    await run(['remote', 'card', 'clear'])
    expect(apiDelete).toHaveBeenCalledWith('/api/amtp/agents/me/card')
  })

  test('card get fetches the peer proxy route', async () => {
    ;(apiGet as ReturnType<typeof mock>).mockResolvedValue({
      verified: true,
      card: { name: 'Bob' },
      signedCard: { v: 1, instanceId: 'peer-inst', handle: 'bob', card: { name: 'Bob' }, cardSig: 'sig' },
    })

    await run(['remote', 'card', 'get', 'peer-1', 'bob'])

    expect(apiGet).toHaveBeenCalledWith('/api/amtp/peers/peer-1/agents/bob/card')
    expect(outputError).not.toHaveBeenCalled()
  })

  test('card get turns a 404 into a clear "no verified card" error', async () => {
    ;(apiGet as ReturnType<typeof mock>).mockRejectedValue(new Error('Not found'))

    await run(['remote', 'card', 'get', 'peer-1', 'bob'])

    expect(outputError).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringMatching(/no verified card/i) })
    )
  })
})
