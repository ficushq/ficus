import { z } from 'zod'

export const RECOVERY_ATTEMPT_BUDGET = 3
export const RECOVERY_MANAGER_CYCLES = 1
/** Existing server-owned work-stream settings; never arbitrary platform evidence. */
export const WORK_STREAM_CONFIG_DECLARATION = 'ficus:work-stream' as const
export const WORK_STREAM_CONFIG_INPUT_KEYS: readonly string[] = ['git.worktree', 'git.branch', 'git.baseBranch']
export const FORENSIC_ASK_REFUSAL =
  'Ask only for a task file, configuration value or product choice; logs, journal output, registry/host state and human-run commands are not valid input requests.'

export const CREDENTIAL_INPUT_REFUSAL =
  'Use the protected credential or integration input surface, not a plaintext task response.'
function isCredentialInputName(text: string): boolean {
  const normalized = text
    .normalize('NFKC')
    .replace(/[\u200b-\u200d\ufeff]/g, '')
    .toLowerCase()
    .replace(/[_-]/g, ' ')
  return /\b(?:passwords?|credentials?|secrets?|api keys?|private keys?|tokens?(?!\s+(?:budget|limit|count|size)))\b/.test(
    normalized
  )
}

function isPlaintextCredentialRequest(text: string): boolean {
  const request = text.normalize('NFKC').replace(/[\u200b-\u200d\ufeff]/g, '')
  return /\b(?:paste|send|provide|enter|share|upload)\b/i.test(request) && isCredentialInputName(request)
}

function normalizedWording(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/[\u200b-\u200d\ufeff]/g, '')
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .trim()
}

/** Wording is a narrow secondary guard; paths and declared keys carry structure. */
export function isForbiddenEvidenceRequest(text: string, proposedAction = false): boolean {
  const normalized = normalizedWording(text)
  // A choice can itself ask the person to perform host forensics. Addressing it
  // as an agent proposal does not make a host action an ordinary task decision.
  const commandText = text
    .normalize('NFKC')
    .replace(/[\u200b-\u200d\ufeff]/g, '')
    .toLowerCase()
    .trim()
  const action = /\b(?:run|execute|invoke|use|check|inspect|read|collect|gather|view|tail)\b/.test(normalized)
  const host = /\b(?:host|server|box|platform|system|production|cluster)\b/.test(normalized)
  if (
    (/\b(?:journalctl|systemctl)\b/.test(commandText) && (action || /^(?:journalctl|systemctl)\b/.test(commandText))) ||
    /\bssh\s+(?:in(?:to)?\b|\S+@\S+|-\S+)/.test(commandText) ||
    /^(?:ssh)\b|\b(?:will|run|execute|invoke|use)\s+ssh\b/.test(commandText) ||
    (/\b(?:docker|kubectl)\b/.test(commandText) && host) ||
    /\b(?:docker|kubectl)\s+(?:ps|logs|inspect|stats|get|describe|exec)\b/.test(commandText) ||
    (action && host && /\b(?:logs?|journal|syslog)\b/.test(normalized))
  )
    return true
  const person = /\byou(?:r)?\b|\bplease\b/.test(normalized)
  const agentProposal = /\b(?:i will|i'll|i can|may i|can i|should i|we will|shall we)\b/.test(normalized)
  if (agentProposal && !person) return false
  // Product behavior is not a request for the person to gather diagnostics.
  if (
    !person &&
    /^(?:which|what|where|how|should|can|does)\b.*\b(?:app|product|ui|dashboard|feature|parser)\b/.test(normalized)
  )
    return false
  const evidence = normalized.replace(/\blog in\b|\blog (?:format|level)s?\b/g, 'product setting')
  const explicitEvidence =
    /\b(?:(?:host|platform|executor|server|box|system|sandbox)\s+(?:state|status|identity|evidence|diagnostics|forensics|logs?)|(?:invocation\s+)?registry\s+(?:records?|dump|state)|journal(?:ctl)?\s+output)\b/.test(
      evidence
    )
  const requested = /\b(?:send|share|paste|upload|provide|supply|collect|gather|give)\b|\bshow me\b/.test(evidence)
  const diagnostics = /\b(?:log\s*files?|logs?|syslogs?|stderr|stdout|dmesg|journald|journalctl|forensics)\b/.test(
    evidence
  )
  const hostCommand =
    /\b(?:ssh|sudo|systemctl|journalctl)\b|\b(?:docker|kubectl)\s+(?:ps|logs|inspect|stats|get|describe|exec)\b|(?:^|\s)(?:cat|tail|grep)\s+\//.test(
      evidence
    )
  const personCommand =
    /\b(?:(?:can|could|would|will)\s+you\s+(?:please\s+)?|you\s+(?:(?:must|should|can|may|need to|have to)\s+)?)(?:run|execute|ssh)\b/.test(
      evidence
    )
  const bareCommand = /(?:^|[.!?:;,\n]\s*|\b(?:please|then|and)\s+)(?:run|execute)\b/.test(evidence)
  const choice = /\bor\b|\bshould (?:i|we)\b/.test(evidence)
  return (
    explicitEvidence ||
    (requested && (diagnostics || hostCommand)) ||
    personCommand ||
    (person && hostCommand) ||
    (!proposedAction && !choice && bareCommand)
  )
}

function isDiagnosticTarget(text: string): boolean {
  const normalized = normalizedWording(text)
  return (
    isForbiddenEvidenceRequest(text) ||
    /\b(?:log\s*files?|logs|syslogs?|stderr|stdout|dmesg|journald|journalctl)\b|\.log(?:$|[./])|(?:^|\/)logs?(?:\/|$)/.test(
      normalized
    )
  )
}

/** Canonical workspace-relative task references, never arbitrary host paths. */
export const workspaceTaskPathSchema = z
  .string()
  .trim()
  .min(1)
  .max(512)

  .refine(
    (path) =>
      // eslint-disable-next-line no-control-regex -- Reject unsafe path controls.
      !/[\\:%*?"<>|\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/.test(path) &&
      path
        .split('/')
        .every(
          (part) => Boolean(part) && !['.', '..', '.ficus', '.git', '.ssh'].includes(part) && part.trim() === part
        ),
    'Use a workspace-relative task path without traversal or managed-state directories'
  )
  .refine((path) => !isDiagnosticTarget(path), FORENSIC_ASK_REFUSAL)
  .refine(
    (path) =>
      !isCredentialInputName(path) &&
      !path
        .split('/')
        .some((part) => part === '.env' || (/^\.env\./.test(part) && !/\.(?:example|sample|template)$/.test(part))),
    CREDENTIAL_INPUT_REFUSAL
  )

const configurationKeySchema = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/, 'Use a declared configuration key')
  .refine((key) => !isDiagnosticTarget(key), FORENSIC_ASK_REFUSAL)
  .refine((key) => !isCredentialInputName(key), CREDENTIAL_INPUT_REFUSAL)

export function assertHumanAnswerableRequest(texts: readonly string[]): void {
  if (texts.some((text) => isForbiddenEvidenceRequest(text))) throw new Error(FORENSIC_ASK_REFUSAL)
  if (texts.some(isPlaintextCredentialRequest)) throw new Error(CREDENTIAL_INPUT_REFUSAL)
}

const plain = (max: number, proposedAction = false) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    // eslint-disable-next-line no-control-regex -- Reject control characters in one-line input labels.
    .refine((text) => !/[\r\n\u0000-\u001f]/.test(text), 'Use a single plain-language line')
    .refine((text) => !isForbiddenEvidenceRequest(text, proposedAction), FORENSIC_ASK_REFUSAL)
    .refine((text) => !isPlaintextCredentialRequest(text), CREDENTIAL_INPUT_REFUSAL)
const scope = {
  schemaVersion: z.literal(1),
  scope: z.enum(['stream', 'attempt']).optional(),
  flowAttemptId: z.int().positive().optional(),
}
const option = z.strictObject({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
  label: plain(120, true),
  consequence: plain(240, true).optional(),
})

export const manualInputRequestSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    ...scope,
    kind: z.literal('continue'),
    recoveryId: z.uuid(),
    expectedRecoveryVersion: z.int().nonnegative(),
  }),
  z.strictObject({
    ...scope,
    actor: z.enum(['human', 'owner']).optional(),
    kind: z.literal('decide'),
    purpose: z.literal('task-decision'),
    subject: plain(160),
    options: z
      .array(option)
      .min(2)
      .max(8)
      .refine(
        (options) => new Set(options.map((option) => option.id)).size === options.length,
        'Option ids must be unique'
      ),
  }),
  z.strictObject({
    ...scope,
    actor: z.enum(['human', 'owner']).optional(),
    kind: z.literal('provide'),
    purpose: z.literal('task-input'),
    input: z
      .discriminatedUnion('type', [
        z.strictObject({ type: z.literal('file'), path: workspaceTaskPathSchema }),
        z.strictObject({
          type: z.literal('config-value'),
          key: configurationKeySchema,
          declaredIn: z.union([workspaceTaskPathSchema, z.literal(WORK_STREAM_CONFIG_DECLARATION)]),
        }),
      ])
      .refine(
        (input) =>
          input.type !== 'config-value' ||
          input.declaredIn !== WORK_STREAM_CONFIG_DECLARATION ||
          WORK_STREAM_CONFIG_INPUT_KEYS.includes(input.key),
        'Use a server-declared work-stream configuration key'
      ),
    use: plain(240),
  }),
])
export type ManualInputRequest = z.infer<typeof manualInputRequestSchema>
export interface RecoverySummary {
  attempted: string
  attemptCount: number
  lastError: string | null
  text: string
}
export interface StructuredManualWait {
  request: ManualInputRequest
  summary: RecoverySummary
  version: number
  stopped?: boolean
}

export const manualWaitDecisionSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('continue'), expectedVersion: z.int().nonnegative() }),
  z.strictObject({ action: z.literal('stop'), expectedVersion: z.int().nonnegative() }),
  z.strictObject({ action: z.literal('forward'), expectedVersion: z.int().nonnegative() }),
  z.strictObject({
    action: z.literal('choose'),
    expectedVersion: z.int().nonnegative(),
    optionId: z.string().min(1).max(64),
  }),
  z.strictObject({
    action: z.literal('provide'),
    expectedVersion: z.int().nonnegative(),
    value: z.string().trim().min(1).max(2000),
  }),
])
export type ManualWaitDecision = z.infer<typeof manualWaitDecisionSchema>

export function taskInputSummary(request: Exclude<ManualInputRequest, { kind: 'continue' }>): RecoverySummary {
  const attempted = request.kind === 'decide' ? request.subject : request.use
  return {
    attempted,
    attemptCount: 0,
    lastError: null,
    text:
      request.kind === 'decide'
        ? `Choose an option for: ${request.subject}.`
        : `Provide ${taskInputLabel(request.input)} to ${request.use}.`,
  }
}

export function taskInputLabel(input: Extract<ManualInputRequest, { kind: 'provide' }>['input']): string {
  return input.type === 'file' ? input.path : input.key
}
