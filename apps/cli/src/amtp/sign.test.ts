import { describe, test, expect } from 'bun:test'
import { generateKeyPairSync, verify } from 'crypto'
import { canonicalAgentSigBytes } from '@ficus/shared'
import { buildFederatedSendBody } from './sign'

const { publicKey, privateKey } = generateKeyPairSync('ed25519')
const priv = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string
const pub = publicKey.export({ type: 'spki', format: 'pem' }) as string

describe('buildFederatedSendBody', () => {
  test('produces an agentSig that verifies over the @ficus/shared canonical subset', () => {
    const body = buildFederatedSendBody({
      from: 'amtp://us/alice',
      to: 'amtp://peer/bob',
      subject: 'hi',
      content: 'hello bob',
      attachments: [{ id: 'att-1', filename: 'f.txt', contentType: 'text/plain', byteSize: 3, sha256: 'abc' }],
      privateKeyPem: priv,
    })
    const bytes = canonicalAgentSigBytes({
      v: 1,
      id: body.id,
      from: 'amtp://us/alice',
      to: 'amtp://peer/bob',
      subject: 'hi',
      content: 'hello bob',
      attachments: [{ filename: 'f.txt', contentType: 'text/plain', byteSize: 3, sha256: 'abc' }],
    })
    expect(verify(null, bytes, pub, Buffer.from(body.agentSig, 'base64'))).toBe(true)
  })

  test('sets a uuid envelope id, derives attachmentIds, and attaches the SPKI agentKey', () => {
    const body = buildFederatedSendBody({
      from: 'amtp://us/alice',
      to: 'amtp://peer/bob',
      content: 'with one attachment',
      attachments: [{ id: 'att-9', filename: 'a', contentType: 'text/plain', byteSize: 1, sha256: 'z' }],
      privateKeyPem: priv,
    })
    expect(body.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    expect(body.attachmentIds).toEqual(['att-9'])
    expect(body.agentKey).toBe(pub)
    expect(body.recipientId).toBe('amtp://peer/bob')
    expect(body.recipientType).toBe('agent')
  })

  test('omits attachmentIds and inReplyToEnvelopeId when not provided', () => {
    const body = buildFederatedSendBody({
      from: 'amtp://us/alice',
      to: 'amtp://peer/bob',
      content: 'plain',
      attachments: [],
      privateKeyPem: priv,
    })
    expect(body.attachmentIds).toBeUndefined()
    expect(body.inReplyToEnvelopeId).toBeUndefined()
  })
})
