import { z } from 'zod'

export const RECOVERY_ATTEMPT_BUDGET = 3
export const RECOVERY_MANAGER_CYCLES = 1
export const FORENSIC_ASK_REFUSAL =
  'Ask only for a task file, configuration value or product choice; logs, journal output, registry/host state and human-run commands are not valid input requests.'

export const CREDENTIAL_INPUT_REFUSAL =
  'Use the protected credential or integration input surface, not a plaintext task response.'
function isCredentialInputName(text: string): boolean {
  const normalized = text.normalize('NFKC').toLowerCase().replace(/[_-]/g, ' ')
  return /\b(?:passwords?|credentials?|secrets?|api keys?|private keys?|tokens?(?!\s+(?:budget|limit|count|size)))\b/.test(
    normalized
  )
}

/** Shared by manual waits and question writers, not just the CLI or one HTTP route. */
export function isForbiddenEvidenceRequest(text: string): boolean {
  const normalized = text
    .normalize('NFKC')
    .replace(/[\u200b-\u200d\ufeff]/g, '')
    .toLowerCase()
  return (
    /\b(?:logs?|journal(?:ctl)?|registry|host[\s_-]+(?:state|status|identity|evidence|diagnostics)|platform[\s_-]+(?:state|forensics|diagnostics))\b/.test(
      normalized
    ) ||
    /\b(?:run|execute)\s+(?:\S+\s*)/i.test(normalized) ||
    /\b(?:sudo|systemctl|journalctl)\b|(?:^|\s)(?:cat|tail|grep)\s+\//i.test(normalized)
  )
}

export function assertHumanAnswerableRequest(texts: readonly string[]): void {
  if (texts.some(isForbiddenEvidenceRequest)) throw new Error(FORENSIC_ASK_REFUSAL)
  if (texts.some((text) => /\b(?:paste|send|provide|enter|share|upload)\b/i.test(text) && isCredentialInputName(text)))
    throw new Error(CREDENTIAL_INPUT_REFUSAL)
}

const plain = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    // eslint-disable-next-line no-control-regex -- Reject control characters in one-line input labels.
    .refine((text) => !/[\r\n\u0000-\u001f]/.test(text), 'Use a single plain-language line')
    .refine((text) => !isForbiddenEvidenceRequest(text), FORENSIC_ASK_REFUSAL)
const scope = {
  schemaVersion: z.literal(1),
  scope: z.enum(['stream', 'attempt']).optional(),
  flowAttemptId: z.int().positive().optional(),
}
const option = z.strictObject({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
  label: plain(120),
  consequence: plain(240).optional(),
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
      .strictObject({ type: z.enum(['file', 'config-value', 'product-choice']), name: plain(160) })
      .refine(
        (input) => input.type === 'product-choice' || !isCredentialInputName(input.name),
        CREDENTIAL_INPUT_REFUSAL
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
        : `Provide ${request.input.name} to ${request.use}.`,
  }
}
