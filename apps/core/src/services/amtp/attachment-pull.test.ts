import { describe, test, expect, beforeEach } from 'bun:test'
import { pullAttachment } from './attachment-pull'
import { sha256Hex } from '../inbox/attachment-storage'
import { generateInstanceKeyPair, instanceIdFromPublicKeyPem } from './crypto'
import { resetSettingsStore } from '../settings/store'
import type { AmtpAttachmentRef } from '@ficus/shared'

const { privateKeyPem, publicKeyPem } = generateInstanceKeyPair()
const INSTANCE_ID = instanceIdFromPublicKeyPem(publicKeyPem)
const signer = async () => ({ instanceId: INSTANCE_ID, privateKeyPem })

function makeRef(bytes: Uint8Array, overrides: Partial<AmtpAttachmentRef> = {}): AmtpAttachmentRef {
  return {
    id: 'att-123',
    filename: 'test.txt',
    contentType: 'text/plain',
    byteSize: bytes.length,
    sha256: sha256Hex(bytes),
    ...overrides,
  }
}

beforeEach(() => {
  resetSettingsStore()
})

describe('pullAttachment', () => {
  test('happy path: resolves with bytes, correct headers and URL path', async () => {
    const bytes = new TextEncoder().encode('hello')
    const ref = makeRef(bytes)

    let capturedUrl: string | undefined
    let capturedHeaders: Record<string, string> | undefined

    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      capturedUrl = String(url)
      capturedHeaders = init?.headers as Record<string, string>
      return new Response(bytes, { status: 200 })
    }) as unknown as typeof fetch

    const result = await pullAttachment({ signer, fetchImpl }, { peerBaseUrl: 'https://peer.example/api', ref })

    expect(result).toEqual(bytes)
    expect(capturedUrl).toBe('https://peer.example/api/amtp/attachments/att-123')
    expect(new URL(capturedUrl!).pathname).toBe('/api/amtp/attachments/att-123')
    expect(capturedHeaders!['x-amtp-instance']).toBe(INSTANCE_ID)
    expect(typeof capturedHeaders!['x-amtp-signature']).toBe('string')
    expect(capturedHeaders!['x-amtp-signature'].length).toBeGreaterThan(0)
    expect(typeof capturedHeaders!['x-amtp-timestamp']).toBe('string')
    expect(Number(capturedHeaders!['x-amtp-timestamp'])).toBeGreaterThan(0)
  })

  test('sha256 mismatch: throws ATTACHMENT_HASH_MISMATCH', async () => {
    const bytes = new TextEncoder().encode('hello')
    const ref = makeRef(bytes, { sha256: 'bad-sha256-value' })

    const fetchImpl = (async () => new Response(bytes, { status: 200 })) as unknown as typeof fetch

    await expect(
      pullAttachment({ signer, fetchImpl }, { peerBaseUrl: 'https://peer.example/api', ref })
    ).rejects.toThrow('ATTACHMENT_HASH_MISMATCH')
  })

  test('byteSize mismatch: throws ATTACHMENT_SIZE_MISMATCH', async () => {
    const bytes = new TextEncoder().encode('hello')
    const ref = makeRef(bytes, { byteSize: 999 })

    const fetchImpl = (async () => new Response(bytes, { status: 200 })) as unknown as typeof fetch

    await expect(
      pullAttachment({ signer, fetchImpl }, { peerBaseUrl: 'https://peer.example/api', ref })
    ).rejects.toThrow('ATTACHMENT_SIZE_MISMATCH')
  })

  test('non-2xx response: throws ATTACHMENT_PULL_FAILED', async () => {
    const bytes = new TextEncoder().encode('hello')
    const ref = makeRef(bytes)

    const fetchImpl = (async () => new Response('not found', { status: 404 })) as unknown as typeof fetch

    await expect(
      pullAttachment({ signer, fetchImpl }, { peerBaseUrl: 'https://peer.example/api', ref })
    ).rejects.toThrow('ATTACHMENT_PULL_FAILED')
  })

  test('oversize ref: throws ATTACHMENT_TOO_LARGE without calling fetch', async () => {
    // Default INBOX_MAX_ATTACHMENT_BYTES is 10485760 (10 MB); use 1 byte over.
    const ref: AmtpAttachmentRef = {
      id: 'att-big',
      filename: 'big.bin',
      contentType: 'application/octet-stream',
      byteSize: 10485761,
      sha256: 'whatever',
    }

    let fetchCalled = false
    const fetchImpl = (async () => {
      fetchCalled = true
      return new Response('', { status: 200 })
    }) as unknown as typeof fetch

    await expect(
      pullAttachment({ signer, fetchImpl }, { peerBaseUrl: 'https://peer.example/api', ref })
    ).rejects.toThrow('ATTACHMENT_TOO_LARGE')

    expect(fetchCalled).toBe(false)
  })

  test('trailing slash in peerBaseUrl: fetched URL has no double slash in path', async () => {
    const bytes = new TextEncoder().encode('data')
    const ref = makeRef(bytes, { id: 'att-456' })

    let capturedUrl: string | undefined
    const fetchImpl = (async (url: string | URL | Request) => {
      capturedUrl = String(url)
      return new Response(bytes, { status: 200 })
    }) as unknown as typeof fetch

    await pullAttachment({ signer, fetchImpl }, { peerBaseUrl: 'https://peer.example/api/', ref })

    expect(capturedUrl).toBe('https://peer.example/api/amtp/attachments/att-456')
    expect(new URL(capturedUrl!).pathname).toBe('/api/amtp/attachments/att-456')
  })
})
