import { describe, expect, test } from 'bun:test'
import { manualInputRequestSchema as requestInputWorkStreamSchema } from './recovery-waits'

const provide = {
  schemaVersion: 1,
  kind: 'provide',
  purpose: 'task-input',
  input: { type: 'config-value', key: 'RELEASE_CHANNEL', declaredIn: 'config/task-inputs.schema.json' },
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
    expect(requestInputWorkStreamSchema.safeParse({ ...provide, input: { type: 'file', path: name } }).success).toBe(
      false
    )
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
          { id: 'a', label: 'Continue', consequence: 'You run journalctl' },
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
    expect(
      requestInputWorkStreamSchema.safeParse({
        ...provide,
        input: { type: 'config-value', key: name, declaredIn: 'config/task-inputs.schema.json' },
      }).success
    ).toBe(false)
  }
  expect(
    requestInputWorkStreamSchema.safeParse({
      ...provide,
      input: { type: 'config-value', key: 'TOKEN_BUDGET', declaredIn: 'config/task-inputs.schema.json' },
    }).success
  ).toBe(true)
})

test('genuine product/configuration questions are not confused with forensic or human-run requests', async () => {
  const { assertHumanAnswerableRequest } = await import('./recovery-waits')
  expect(
    requestInputWorkStreamSchema.safeParse({
      ...provide,
      input: { type: 'config-value', key: 'PACKAGE_REGISTRY_URL', declaredIn: 'config/task-inputs.schema.json' },
    }).success
  ).toBe(true)
  for (const question of [
    'Which log in layout should I use?',
    'Which log format should the product display?',
    'Which CI run should the dashboard link to?',
    'May I run the approved release step?',
  ])
    expect(() => assertHumanAnswerableRequest([question])).not.toThrow()
  for (const request of [
    'invocation_registry_records',
    'host_state',
    'Could you execute the check on the host?',
    'Please run npm test',
    'Run the command',
    '  Run npm test',
    'Continue, then execute this command',
  ])
    expect(() => assertHumanAnswerableRequest([request])).toThrow('not valid')
})

test('a product-choice label or generic input name cannot disguise a plaintext credential request', () => {
  expect(
    requestInputWorkStreamSchema.safeParse({ ...provide, input: { type: 'product-choice', name: 'access token' } })
      .success
  ).toBe(false)
  expect(requestInputWorkStreamSchema.safeParse({ ...provide, use: 'Pa\u200bste your API key' }).success).toBe(false)
  expect(
    requestInputWorkStreamSchema.safeParse({ ...provide, input: { type: 'config-value', name: 'pa\u200bssword' } })
      .success
  ).toBe(false)
})

test.each([
  'Please share the logfile from the box',
  'Share the stderr and dmesg output',
  'Paste the output of docker ps from the server',
  'You SSH in and check',
  'Please upload the syslog files',
  'I will SSH into the authorized project environment and check',
])('rejects the reviewed forensic paraphrase: %s', async (text) => {
  const { isForbiddenEvidenceRequest } = await import('./recovery-waits')
  expect(isForbiddenEvidenceRequest(text)).toBe(true)
})

test.each([
  'Which container registry should we push to?',
  'Should the app show an audit log page?',
  'Run the migration now, or wait for review?',
])('allows genuine product questions and agent-proposed actions: %s', async (text) => {
  const { isForbiddenEvidenceRequest } = await import('./recovery-waits')
  expect(isForbiddenEvidenceRequest(text)).toBe(false)
})

test('provide requires a workspace-relative task path or a key with a declaration; choices use decide', () => {
  for (const path of [
    '/var/log/messages',
    '../host-state.json',
    'a/../../state',
    'C:\\logs',
    'https://host/file',
    'a//b',
    'executor stderr dump',
    '.ficus/state.json',
  ])
    expect(requestInputWorkStreamSchema.safeParse({ ...provide, input: { type: 'file', path } }).success).toBe(false)
  expect(
    requestInputWorkStreamSchema.safeParse({ ...provide, input: { type: 'file', path: 'assets/logo.svg' } }).success
  ).toBe(true)
  expect(
    requestInputWorkStreamSchema.safeParse({ ...provide, input: { type: 'config-value', key: 'PUBLIC_BASE_URL' } })
      .success
  ).toBe(false)
  expect(
    requestInputWorkStreamSchema.safeParse({ ...provide, input: { type: 'product-choice', name: 'Layout' } }).success
  ).toBe(false)
  expect(
    requestInputWorkStreamSchema.safeParse({
      schemaVersion: 1,
      kind: 'decide',
      purpose: 'task-decision',
      subject: 'Choose the migration timing',
      options: [
        { id: 'run', label: 'Run the migration' },
        { id: 'wait', label: 'Wait for review' },
      ],
    }).success
  ).toBe(true)
  expect(
    requestInputWorkStreamSchema.safeParse({
      schemaVersion: 1,
      kind: 'decide',
      purpose: 'task-decision',
      subject: 'Choose a path',
      options: [
        { id: 'host', label: 'You SSH in and check' },
        { id: 'stop', label: 'Stop' },
      ],
    }).success
  ).toBe(false)
})

test('product logging questions remain legitimate while explicit human execution requests do not', async () => {
  const { isForbiddenEvidenceRequest } = await import('./recovery-waits')
  expect(isForbiddenEvidenceRequest('Which logs should the app collect?')).toBe(false)
  expect(isForbiddenEvidenceRequest('You can run npm test and share the results')).toBe(true)
})

test('platform configuration uses only the server-declared work-stream keys', () => {
  for (const key of ['git.worktree', 'git.branch', 'git.baseBranch'])
    expect(
      requestInputWorkStreamSchema.safeParse({
        ...provide,
        input: { type: 'config-value', key, declaredIn: 'ficus:work-stream' },
      }).success
    ).toBe(true)
  expect(
    requestInputWorkStreamSchema.safeParse({
      ...provide,
      input: { type: 'config-value', key: 'HOST_STATE', declaredIn: 'ficus:work-stream' },
    }).success
  ).toBe(false)
  expect(
    requestInputWorkStreamSchema.safeParse({
      ...provide,
      input: { type: 'config-value', key: 'invented', declaredIn: 'ficus:work-stream' },
    }).success
  ).toBe(false)
})

test('host actions are forbidden in decision subjects and options regardless of addressee', () => {
  const decision = {
    schemaVersion: 1,
    kind: 'decide',
    purpose: 'task-decision',
    subject: 'Choose the next task step',
    options: [
      { id: 'go', label: 'Run the workspace tests' },
      { id: 'stop', label: 'Stop' },
    ],
  }
  for (const text of [
    'Run journalctl -u ficus on the host',
    'SSH into the box and check',
    'I will run systemctl status ficus',
    'Run docker inspect on the server',
    'Use kubectl against the production server',
    'Read the host logs',
    'I can read logs on the host',
    'journalctl -u ficus',
    'ssh admin@server',
  ]) {
    expect(requestInputWorkStreamSchema.safeParse({ ...decision, subject: text }).success).toBe(false)
    expect(
      requestInputWorkStreamSchema.safeParse({
        ...decision,
        options: [
          { id: 'go', label: text },
          { id: 'stop', label: 'Stop' },
        ],
      }).success
    ).toBe(false)
  }
  for (const label of [
    'Run npm test in my workspace',
    'I will inspect the project files',
    'Run docker compose build in the workspace',
    'Run the migration',
  ])
    expect(
      requestInputWorkStreamSchema.safeParse({
        ...decision,
        options: [
          { id: 'go', label },
          { id: 'stop', label: 'Stop' },
        ],
      }).success
    ).toBe(true)
})
