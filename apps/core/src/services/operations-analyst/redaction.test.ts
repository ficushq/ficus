import { describe, expect, it } from 'bun:test'
import { REDACTION_VERSION, generatedEvidence, redactEvidence } from './redaction'

describe('redactEvidence', () => {
  it('removes exact configured values and credential shapes', () => {
    const raw = 'Authorization: Bearer ghp_abc123 TOKEN=known-secret --password hunter2'
    const safe = redactEvidence(raw, ['known-secret'])
    expect(safe).not.toContain('known-secret')
    expect(safe).not.toContain('ghp_abc123')
    expect(safe).not.toContain('hunter2')
    expect(safe).toContain('[REDACTED]')
  })

  it('redacts configured secrets longest-first, including regex characters', () => {
    const safe = redactEvidence('value=abcd1234 then abcd and a.b[c]', ['abcd', 'abcd1234', 'a.b[c]'])
    expect(String(safe)).toBe('value=[REDACTED] then [REDACTED] and [REDACTED]')
  })

  it.each([
    ['bearer auth', 'Authorization: Bearer bearer-secret-value'],
    ['basic auth', 'authorization: Basic dXNlcjpwYXNz'],
    ['cookie', 'Cookie: session=super-secret; theme=dark'],
    ['set cookie', 'Set-Cookie: auth_token=super-secret; HttpOnly'],
    ['key/value', 'api_key: super-secret-value password=hunter2'],
    ['CLI space flag', 'tool --token super-secret-value'],
    ['CLI equals flag', 'tool --client-secret=super-secret-value'],
    ['credential URL', 'https://alice:hunter2@example.test/path'],
    ['credential query', 'https://example.test/?access_token=super-secret-value&ok=yes'],
    ['PEM private key', 'before\n-----BEGIN PRIVATE KEY-----\nabc123\n-----END PRIVATE KEY-----\nafter'],
    ['JWT', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.signature-value'],
    ['Ficus token', 'tau_abcdefghijklmno'],
    ['Ficus system token', 'ficus_sys_abcdefghijklmno'],
    ['Ficus device token', 'ficus_dev_abcdefghijklmno'],
    ['GitHub token', 'github_pat_abcdefghijklmno_123456789'],
    ['provider token', 'sk-ant-api03-abcdefghijklmno'],
  ])('redacts %s', (_name, raw) => {
    const safe = redactEvidence(raw, [])
    expect(safe).toContain('[REDACTED]')
    expect(safe).not.toContain('super-secret-value')
  })

  it('cleans control characters, bounds output, and is idempotent', () => {
    const raw = `  useful\u0000 evidence\n\t${'x'.repeat(400)}  `
    const once = redactEvidence(raw, [])
    expect(String(once)).toBe(`useful evidence ${'x'.repeat(304)}`)
    expect(once.length).toBe(320)
    expect(String(redactEvidence(once, []))).toBe(String(once))
  })

  it('does not redact non-secret near misses', () => {
    const raw = 'tokenization complete; passwordless login enabled; https://example.test/path?theme=dark; ghp_short'
    expect(String(redactEvidence(raw, []))).toBe(raw)
  })

  it('brands generated evidence through the same redactor', () => {
    expect(String(generatedEvidence('  stable\nidentifier  '))).toBe('stable identifier')
    expect(REDACTION_VERSION).toBe('ops-redaction-v1')
  })
})
