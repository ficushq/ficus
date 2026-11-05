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
    'Check systemctl status ficus',
    'Inspect journalctl -u ficus',
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
    'Build the Docker image for the app server in my workspace',
    'Which logs should the app server collect?',
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

describe('approval for an action the agent will perform itself', () => {
  // The real rejected context from an agent operating a user's Xion indexer node.
  const xionContext =
    '1. Restart it once (recommended, about the same as the restart you already accepted): run `systemctl restart xion` once. ' +
    'The graceful stop closes the FIFO, so PM2 restarts the tracer automatically (on the same bcc56f8 build), and the node ' +
    "reopens the FIFO when it starts. I'll verify replay of 19,635,624, catch-up, export continuity and queues, and stop it " +
    'gracefully again if it panics during catch-up.'

  test.each([
    xionContext,
    'May I gracefully restart xion.service once to recover it?',
    "I'll run systemctl restart xion once, as you approved yesterday.",
    'May I run `sudo systemctl --user reload indexer`?',
    'Should I stop the node with systemctl stop xion before the upgrade you scheduled?',
  ])('accepts: %s', async (text) => {
    const { isForbiddenEvidenceRequest } = await import('./recovery-waits')
    expect(isForbiddenEvidenceRequest(text)).toBe(false)
  })

  test.each([
    'Please run systemctl restart xion',
    'Can you run systemctl status xion and paste the output?',
    'SSH into the box and check the logs',
    'Run systemctl restart xion',
    'systemctl restart xion',
    'Could you restart xion with systemctl restart xion?',
    "I'll wait while you run systemctl restart xion",
    'I will run systemctl status xion',
    "I'll run systemctl --no-pager status xion and decide",
    'May I run systemctl?',
    'I will run `journalctl -u xion` and summarise it',
    'May I run systemctl restart xion? Please paste your journal output afterwards.',
    'Should I wait for you to send the host logs?',
    "I'll restart xion once you have the server logs ready",
    "I'll send you the host state before restarting",
  ])('still rejects: %s', async (text) => {
    const { isForbiddenEvidenceRequest } = await import('./recovery-waits')
    expect(isForbiddenEvidenceRequest(text)).toBe(true)
  })

  test("a typed decide option may propose a lifecycle action only as the agent's own action", () => {
    const decision = (label: string) => ({
      schemaVersion: 1,
      kind: 'decide',
      purpose: 'task-decision',
      subject: 'Recover the indexer node',
      options: [
        { id: 'go', label },
        { id: 'stop', label: 'Leave it stopped' },
      ],
    })
    expect(requestInputWorkStreamSchema.safeParse(decision("I'll run systemctl restart xion once")).success).toBe(true)
    expect(requestInputWorkStreamSchema.safeParse(decision('Run systemctl restart xion')).success).toBe(false)
    expect(requestInputWorkStreamSchema.safeParse(decision('You run systemctl restart xion')).success).toBe(false)
  })
})

describe('located refusals', () => {
  test('names the offending field and suggests a rephrasing, keeping the stable refusal prefix', async () => {
    const { assertHumanAnswerableRequest, FORENSIC_ASK_REFUSAL, HumanRequestRefusalError } =
      await import('./recovery-waits')
    let caught: unknown
    try {
      assertHumanAnswerableRequest([
        { text: 'May I restart xion.service once?', location: "the text of question 'restart'" },
        { text: 'Can you run systemctl status xion?', location: "the context of question 'restart'" },
      ])
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(HumanRequestRefusalError)
    const error = caught as InstanceType<typeof HumanRequestRefusalError>
    expect(error.reason).toBe('forensic')
    expect(error.location).toBe("the context of question 'restart'")
    expect(error.message.startsWith(FORENSIC_ASK_REFUSAL)).toBe(true)
    expect(error.message).toContain("Rejected text: the context of question 'restart'.")
    expect(error.message).toContain('describe that action in plain words')
  })

  test('plain string callers keep the refusal text and hint without a location', async () => {
    const { assertHumanAnswerableRequest, FORENSIC_ASK_REFUSAL, CREDENTIAL_INPUT_REFUSAL } =
      await import('./recovery-waits')
    expect(() => assertHumanAnswerableRequest(['Send host logs'])).toThrow(FORENSIC_ASK_REFUSAL)
    expect(() => assertHumanAnswerableRequest(['Send host logs'])).not.toThrow('Rejected text')
    expect(() => assertHumanAnswerableRequest(['Paste your API key'])).toThrow(CREDENTIAL_INPUT_REFUSAL)
  })

  test('proposed-action fields are checked like typed decide option labels', async () => {
    const { assertHumanAnswerableRequest } = await import('./recovery-waits')
    expect(() =>
      assertHumanAnswerableRequest([{ text: 'Run the workspace tests', proposedAction: true }])
    ).not.toThrow()
    expect(() => assertHumanAnswerableRequest([{ text: 'Run the workspace tests' }])).toThrow('not valid')
    expect(() => assertHumanAnswerableRequest([{ text: 'You SSH in and check', proposedAction: true }])).toThrow(
      'not valid'
    )
  })
})

describe('ask_human question checks', () => {
  const xionQuestion = {
    id: 'restart',
    question: 'May I gracefully restart xion.service once to recover it?',
    context:
      '1. Restart it once (recommended, about the same as the restart you already accepted): run `systemctl restart xion` once. ' +
      'The graceful stop closes the FIFO, so PM2 restarts the tracer automatically (on the same bcc56f8 build), and the node ' +
      "reopens the FIFO when it starts. I'll verify replay of 19,635,624, catch-up, export continuity and queues, and stop it " +
      'gracefully again if it panics during catch-up.',
    options: [
      { value: 'restart', label: 'Restart it once (recommended)' },
      { value: 'leave', label: 'Leave it stopped' },
    ],
  }

  test('accepts the Xion restart approval request', async () => {
    const { assertHumanAnswerableQuestions } = await import('./recovery-waits')
    expect(() => assertHumanAnswerableQuestions([xionQuestion])).not.toThrow()
  })

  test.each([
    ['question', { question: 'Please run systemctl restart xion' }, "the text of question 'restart'"],
    [
      'context',
      { context: 'Can you run systemctl status xion and paste the output?' },
      "the context of question 'restart'",
    ],
    [
      'option',
      { options: [{ value: 'ssh', label: 'SSH into the box and check the logs' }] },
      "option 'ssh' of question 'restart'",
    ],
  ])('rejects a human-directed %s and names it', async (_field, change, location) => {
    const { assertHumanAnswerableQuestions } = await import('./recovery-waits')
    expect(() =>
      assertHumanAnswerableQuestions([
        { id: 'other', question: 'Proceed?' },
        { ...xionQuestion, ...change },
      ])
    ).toThrow(`Rejected text: ${location}.`)
  })
})
