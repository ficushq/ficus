import { describe, it, test, expect, beforeAll, beforeEach, afterEach, mock } from 'bun:test'
import { Command } from 'commander'
import { createPublicKey, generateKeyPairSync, verify } from 'crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { canonicalAgentSigBytes } from '@ficus/shared'
import { apiGet, apiGetRaw, apiPost } from '../client'
import { outputError } from '../output'
import { collectAttachments, getInboxSendDeliveryMode, registerInboxCommands } from './inbox'

describe('inbox --attach option', () => {
  test('collectAttachments accumulates repeated paths', () => {
    expect(collectAttachments('a.txt', [])).toEqual(['a.txt'])
    expect(collectAttachments('b.txt', ['a.txt'])).toEqual(['a.txt', 'b.txt'])
  })
})

describe('inbox CLI commands', () => {
  beforeEach(() => {
    ;(apiPost as ReturnType<typeof mock>).mockClear()
    ;(apiPost as ReturnType<typeof mock>).mockResolvedValue({ id: 'message-12345678' })
  })

  async function run(args: string[]): Promise<void> {
    const program = new Command()
    program.exitOverride()
    registerInboxCommands(program)
    await program.parseAsync(args, { from: 'user' })
  }

  describe('getInboxSendDeliveryMode', () => {
    it('defaults to steer unless --follow-up is set', () => {
      expect(getInboxSendDeliveryMode({})).toBe('steer')
      expect(getInboxSendDeliveryMode({ followUp: true })).toBe('follow-up')
    })
  })

  let inboxCommand: Command | undefined

  beforeAll(() => {
    const program = new Command()
    program.exitOverride()
    registerInboxCommands(program)
    inboxCommand = program.commands.find((c) => c.name() === 'inbox')
  })

  it('documents steer as the default send delivery mode', () => {
    const sendCommand = inboxCommand?.commands.find((c) => c.name() === 'send')
    const steerOption = sendCommand?.options.find((option) => option.long === '--steer')
    const followUpOption = sendCommand?.options.find((option) => option.long === '--follow-up')

    expect(steerOption?.description).toContain('default')
    expect(followUpOption?.description).not.toContain('default')
  })

  it('only documents the system recipient shorthand for send', () => {
    const sendCommand = inboxCommand?.commands.find((c) => c.name() === 'send')
    const recipientTypeOption = sendCommand?.options.find((option) => option.long === '--recipient-type')

    expect(sendCommand?.description()).toContain('"system" for the system inbox')
    expect(sendCommand?.description()).not.toContain('"me"')
    expect(sendCommand?.description()).not.toContain('"user"')
    expect(recipientTypeOption?.description).toContain('system for recipient ID "system"')
    expect(recipientTypeOption?.description).not.toContain('"me"')
    expect(recipientTypeOption?.description).not.toContain('"user"')
  })

  it('treats "system" as the system recipient shorthand for send', async () => {
    await run(['inbox', 'send', 'system', 'hello system'])

    expect(apiPost).toHaveBeenCalledWith(
      '/api/inbox',
      expect.objectContaining({
        recipientType: 'system',
        recipientId: 'system',
        content: 'hello system',
      })
    )
  })

  it.each(['user', 'me'])("treats '%s' as an agent recipient by default", async (recipientId) => {
    await run(['inbox', 'send', recipientId, 'hello'])

    expect(apiPost).toHaveBeenCalledWith(
      '/api/inbox',
      expect.objectContaining({
        recipientType: 'agent',
        recipientId,
        content: 'hello',
      })
    )
  })

  it('send-system honors --recipient-type so automation can address a user inbox', async () => {
    await run(['inbox', 'send-system', 'user-1', 'fleet alert', '--recipient-type', 'user', '-s', 'Alert'])

    expect(apiPost).toHaveBeenCalledWith(
      '/api/inbox',
      expect.objectContaining({
        recipientType: 'user',
        recipientId: 'user-1',
        asSystem: true,
        subject: 'Alert',
        content: 'fleet alert',
      })
    )
  })

  it('sends an Assistant task status at the top level and never inside metadata', async () => {
    const recipientId = 'assistant:57bd78ce-0344-45cf-8e1b-798d1b764b56'
    const requestId = '395cd9c1-1f01-4fe8-a9fa-157e77516843'
    await run([
      'inbox',
      'send',
      recipientId,
      'The comparison is finished.',
      '--recipient-type',
      'voice_assistant',
      '--in-reply-to',
      requestId,
      '--assistant-task-status',
      'completed',
    ])
    expect(apiPost).toHaveBeenCalledTimes(1)
    const [path, body] = (apiPost as ReturnType<typeof mock>).mock.calls[0] as [string, Record<string, unknown>]
    expect(path).toBe('/api/inbox')
    expect(body).toEqual({
      recipientType: 'voice_assistant',
      recipientId,
      subject: undefined,
      content: 'The comparison is finished.',
      metadata: undefined,
      inReplyTo: requestId,
      assistantTaskStatus: 'completed',
      deliveryMode: 'steer',
    })
  })

  it('rejects an unsupported Assistant task status before sending', async () => {
    await expect(
      run([
        'inbox',
        'send',
        'assistant:57bd78ce-0344-45cf-8e1b-798d1b764b56',
        'Done',
        '--recipient-type',
        'voice_assistant',
        '--in-reply-to',
        '395cd9c1-1f01-4fe8-a9fa-157e77516843',
        '--assistant-task-status',
        'done',
      ])
    ).rejects.toThrow()
    expect(apiPost).not.toHaveBeenCalled()
  })

  it('rejects the Assistant task status for federated sends before signing or posting', async () => {
    await run(['inbox', 'send', 'amtp://peerinst/bob', 'hello', '--assistant-task-status', 'working'])
    expect(apiPost).not.toHaveBeenCalled()
    expect(outputError).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('--assistant-task-status') })
    )
  })

  it('preserves the full reply ID for a local Assistant inbox reply', async () => {
    const recipientId = 'assistant:57bd78ce-0344-45cf-8e1b-798d1b764b56'
    const requestId = '395cd9c1-1f01-4fe8-a9fa-157e77516843'
    await run([
      'inbox',
      'send',
      recipientId,
      'Here is the result',
      '--recipient-type',
      'voice_assistant',
      '--in-reply-to',
      requestId,
    ])
    expect(apiPost).toHaveBeenCalledWith(
      '/api/inbox',
      expect.objectContaining({
        recipientId,
        recipientType: 'voice_assistant',
        content: 'Here is the result',
        inReplyTo: requestId,
      })
    )
  })
})

describe('inbox send amtp:// (federation)', () => {
  let dir: string
  let publicPem: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'fed-send-'))
    const { privateKey, publicKey } = generateKeyPairSync('ed25519')
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string
    publicPem = publicKey.export({ type: 'spki', format: 'pem' }) as string
    writeFileSync(join(dir, 'identity.pem'), pem)
    writeFileSync(
      join(dir, 'identity.json'),
      JSON.stringify({ handle: 'alice', address: 'amtp://us/alice', identityPublicKey: 'PUB' })
    )
    process.env.FICUS_IDENTITY_PEM = join(dir, 'identity.pem')
    process.env.FICUS_IDENTITY_CACHE = join(dir, 'identity.json')
    ;(apiPost as ReturnType<typeof mock>).mockClear()
    ;(apiPost as ReturnType<typeof mock>).mockResolvedValue({ enqueued: true, outboxId: 'outbox-abcdef12' })
    ;(apiGet as ReturnType<typeof mock>).mockClear()
    ;(apiGet as ReturnType<typeof mock>).mockResolvedValue({
      handle: 'alice',
      address: 'amtp://us/alice',
      registered: true,
      federationReady: true,
      inboundOpen: false,
      allowsInbound: false,
      allowRules: [],
      card: null,
      agentName: null,
      agentDescription: null,
      signingIdentity: {
        status: 'ready',
        reason: null,
        message: null,
        identityPublicKey: publicPem,
      },
    })
    ;(apiGetRaw as ReturnType<typeof mock>).mockClear()
    ;(outputError as ReturnType<typeof mock>).mockClear()
  })
  afterEach(() => {
    delete process.env.FICUS_IDENTITY_PEM
    delete process.env.FICUS_IDENTITY_CACHE
    rmSync(dir, { recursive: true, force: true })
  })

  async function run(args: string[]): Promise<void> {
    const program = new Command()
    program.exitOverride()
    registerInboxCommands(program)
    await program.parseAsync(args, { from: 'user' })
  }

  test('detects amtp://, signs, and posts an envelope (id + agentKey + agentSig)', async () => {
    await run(['inbox', 'send', 'amtp://peerinst/bob', 'hello bob'])
    expect(apiPost).toHaveBeenCalledWith(
      '/api/inbox',
      expect.objectContaining({
        recipientId: 'amtp://peerinst/bob',
        content: 'hello bob',
        id: expect.any(String),
        agentKey: expect.any(String),
        agentSig: expect.any(String),
      })
    )
  })

  test('fails before POST and attachment resolution when the local PEM is missing', async () => {
    rmSync(process.env.FICUS_IDENTITY_PEM!)
    await run(['inbox', 'send', 'amtp://peerinst/bob', 'hello', '--attachment-id', 'att-1'])
    expect(apiPost).not.toHaveBeenCalled()
    expect(apiGetRaw).not.toHaveBeenCalled()
  })

  test('fails before POST and attachment resolution when local and server keys mismatch', async () => {
    writeFileSync(
      process.env.FICUS_IDENTITY_PEM!,
      generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }) as string
    )
    await run(['inbox', 'send', 'amtp://peerinst/bob', 'hello', '--attachment-id', 'att-1'])
    expect(apiPost).not.toHaveBeenCalled()
    expect(apiGetRaw).not.toHaveBeenCalled()
  })

  test('ignores a stale cached address and uses live status', async () => {
    writeFileSync(
      process.env.FICUS_IDENTITY_CACHE!,
      JSON.stringify({ handle: 'old', address: 'amtp://old/old', identityPublicKey: publicPem })
    )
    await run(['inbox', 'send', 'amtp://peerinst/bob', 'hello'])
    expect(apiGet).toHaveBeenCalledWith('/api/amtp/agents/me/status')
    const body = (apiPost as ReturnType<typeof mock>).mock.calls[0][1] as Record<string, any>
    const sig = Buffer.from(body.agentSig, 'base64')
    const fields = {
      v: 1 as const,
      id: body.id,
      from: 'amtp://us/alice',
      to: body.recipientId,
      subject: body.subject,
      content: body.content,
      attachments: [],
    }
    expect(verify(null, Buffer.from(canonicalAgentSigBytes(fields)), createPublicKey(body.agentKey), sig)).toBe(true)
    expect(
      verify(
        null,
        Buffer.from(canonicalAgentSigBytes({ ...fields, from: 'amtp://old/old' })),
        createPublicKey(body.agentKey),
        sig
      )
    ).toBe(false)
  })

  test('fails before POST when the server key is unavailable', async () => {
    ;(apiGet as ReturnType<typeof mock>).mockResolvedValueOnce({
      registered: true,
      federationReady: false,
      address: 'amtp://us/alice',
      signingIdentity: { status: 'unavailable', message: 'Missing key.', identityPublicKey: null },
    })
    await run(['inbox', 'send', 'amtp://peerinst/bob', 'hello'])
    expect(apiPost).not.toHaveBeenCalled()
  })

  test('the posted agentSig verifies against canonicalAgentSigBytes; tampering invalidates it', async () => {
    await run(['inbox', 'send', 'amtp://peerinst/bob', 'hello bob'])
    const body = (apiPost as ReturnType<typeof mock>).mock.calls[0][1] as Record<string, any>
    // Reconstruct the canonical bytes from the posted fields. from = the cached self address;
    // to = recipientId. If the command wired the wrong from/to/content into the signer, this fails.
    const fields = {
      v: 1 as const,
      id: body.id as string,
      from: 'amtp://us/alice',
      to: body.recipientId as string,
      subject: body.subject as string | undefined,
      content: body.content as string,
      attachments: [] as { filename: string; contentType: string; byteSize: number; sha256: string }[],
    }
    const pub = createPublicKey(body.agentKey as string)
    const sig = Buffer.from(body.agentSig as string, 'base64')
    expect(verify(null, Buffer.from(canonicalAgentSigBytes(fields)), pub, sig)).toBe(true)
    // Tampering with the content must invalidate the signature (the bytes no longer match).
    const tampered = canonicalAgentSigBytes({ ...fields, content: 'HACKED' })
    expect(verify(null, Buffer.from(tampered), pub, sig)).toBe(false)
  })

  test('handles the 202 {enqueued, outboxId} response without assuming an InboxMessage id', async () => {
    await run(['inbox', 'send', 'amtp://peerinst/bob', 'hi'])
    // The local path would read message.id.slice(...); the federated path must not throw on a body
    // that has no `id` field. A clean resolution means outputError was never invoked.
    expect(outputError).not.toHaveBeenCalled()
  })

  test('rejects fresh --attach uploads for a remote recipient without sending', async () => {
    await run(['inbox', 'send', 'amtp://peerinst/bob', 'hi', '--attach', '/tmp/whatever.txt'])
    expect(apiPost).not.toHaveBeenCalled()
    expect(outputError).toHaveBeenCalled()
  })

  test('resolves --attachment-id refs via GET and includes attachmentIds', async () => {
    ;(apiGetRaw as ReturnType<typeof mock>).mockResolvedValue(
      new Response(new Uint8Array([1, 2, 3]), {
        headers: { 'content-type': 'text/plain', 'content-disposition': 'attachment; filename="f.txt"' },
      })
    )
    await run(['inbox', 'send', 'amtp://peerinst/bob', 'with file', '--attachment-id', 'att-1'])
    expect(apiGetRaw).toHaveBeenCalledWith('/api/inbox/attachments/att-1')
    expect(apiPost).toHaveBeenCalledWith('/api/inbox', expect.objectContaining({ attachmentIds: ['att-1'] }))
  })
})
