import { describe, expect, test } from 'bun:test'
import { requestInputWorkStreamSchema } from './schemas'

const provide = {
  schemaVersion: 1,
  kind: 'provide',
  purpose: 'task-input',
  input: { type: 'config-value', name: 'release channel' },
  use: 'Select the deployment target',
}

describe('structured input requests', () => {
  test('accepts exact named task input without manufacturing failed attempts', () => {
    expect(requestInputWorkStreamSchema.safeParse(provide).success).toBe(true)
  })
  test('accepts a recovery reference, never caller-authored attempt counts or summaries', () => {
    const request = {
      schemaVersion: 1,
      kind: 'continue',
      recoveryId: '19e26b08-a5c1-4819-9f1d-796e27aba7ce',
      expectedRecoveryVersion: 2,
    }
    expect(requestInputWorkStreamSchema.safeParse(request).success).toBe(true)
    expect(requestInputWorkStreamSchema.safeParse({ ...request, attemptCount: 3 }).success).toBe(false)
    expect(requestInputWorkStreamSchema.safeParse({ ...request, message: 'please continue' }).success).toBe(false)
  })
  test('rejects the free-text forensic request', () => {
    expect(requestInputWorkStreamSchema.safeParse({ message: 'Send host logs' }).success).toBe(false)
  })
  test.each([
    'host logs',
    'journal output',
    'journalctl output',
    'invocation registry records',
    'host state',
    'run sudo ps aux',
    'execute this command',
    'please run npm test',
  ])('rejects a typed provide disguised as %s', (name) => {
    expect(requestInputWorkStreamSchema.safeParse({ ...provide, input: { type: 'file', name } }).success).toBe(false)
  })
  test('rejects forbidden asks in use, decision subject, option labels and consequences too', () => {
    expect(requestInputWorkStreamSchema.safeParse({ ...provide, use: 'Please supply logs' }).success).toBe(false)
    const decide = {
      schemaVersion: 1,
      kind: 'decide',
      purpose: 'task-decision',
      subject: 'Choose a layout',
      options: [
        { id: 'a', label: 'Compact' },
        { id: 'b', label: 'Spacious' },
      ],
    }
    expect(requestInputWorkStreamSchema.safeParse(decide).success).toBe(true)
    expect(requestInputWorkStreamSchema.safeParse({ ...decide, subject: 'Collect host state' }).success).toBe(false)
    expect(
      requestInputWorkStreamSchema.safeParse({
        ...decide,
        options: [
          { id: 'a', label: 'Send logs' },
          { id: 'b', label: 'Stop' },
        ],
      }).success
    ).toBe(false)
    expect(
      requestInputWorkStreamSchema.safeParse({
        ...decide,
        options: [
          { id: 'a', label: 'Continue', consequence: 'Run journalctl' },
          { id: 'b', label: 'Stop' },
        ],
      }).success
    ).toBe(false)
  })
  test('requires at least two unique decision options and disallows unknown provide categories', () => {
    expect(
      requestInputWorkStreamSchema.safeParse({ ...provide, input: { type: 'value', name: 'anything' } }).success
    ).toBe(false)
    expect(
      requestInputWorkStreamSchema.safeParse({
        schemaVersion: 1,
        kind: 'decide',
        purpose: 'task-decision',
        subject: 'Choice',
        options: [
          { id: 'same', label: 'A' },
          { id: 'same', label: 'B' },
        ],
      }).success
    ).toBe(false)
  })
})

test('credentials remain on protected input surfaces, not named plaintext provide responses', () => {
  for (const name of ['OPENAI_API_KEY', 'access token', 'password', 'private key', 'integration credentials']) {
    expect(requestInputWorkStreamSchema.safeParse({ ...provide, input: { type: 'config-value', name } }).success).toBe(
      false
    )
  }
  expect(
    requestInputWorkStreamSchema.safeParse({ ...provide, input: { type: 'config-value', name: 'token budget' } })
      .success
  ).toBe(true)
})
