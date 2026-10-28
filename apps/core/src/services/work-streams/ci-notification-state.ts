import { z } from 'zod'

const decimal = z.string().regex(/^[1-9][0-9]{0,19}$/)
export const ciNotificationSchema = z.object({
  recipientId: z.uuid(),
  repository: z
    .string()
    .regex(/^[\w.-]+\/[\w.-]+$/)
    .max(200),
  workflowId: decimal,
  runId: decimal,
  runNumber: decimal,
  runAttempt: decimal,
  conclusion: z.enum([
    'success',
    'failure',
    'cancelled',
    'timed_out',
    'action_required',
    'neutral',
    'skipped',
    'stale',
    'startup_failure',
  ]),
  subject: z.string().max(1000),
  content: z.string().max(20_000),
})
export type Notification = z.infer<typeof ciNotificationSchema>
type Watermark = Pick<Notification, 'runId' | 'runNumber' | 'runAttempt' | 'conclusion'>
const watermarkSchema = ciNotificationSchema.pick({ runId: true, runNumber: true, runAttempt: true, conclusion: true })
const MAX_WORKFLOWS = 128

export function advanceWorkflowState(
  value: unknown,
  input: Notification
): { accepted: false; reason: string } | { accepted: true; workflows: Record<string, Watermark> } {
  if (value !== undefined && (value === null || typeof value !== 'object' || Array.isArray(value)))
    return { accepted: false, reason: 'malformed workflow state' }
  const ci = (value ?? {}) as Record<string, unknown>
  // A scalar has no workflow identity. Guessing its partition can cause either
  // a duplicate notification or suppress a different workflow. Require an
  // explicit operator migration for that stream; others still settle normally.
  if (Object.keys(ci).some((key) => key.startsWith('lastNotified')))
    return { accepted: false, reason: 'legacy state requires migration' }
  const parsed = z
    .record(z.string().regex(/^[\w.-]+\/[\w.-]+#[1-9][0-9]{0,19}$/), watermarkSchema)
    .safeParse(ci.workflows === undefined ? {} : ci.workflows)
  if (!parsed.success) return { accepted: false, reason: 'malformed workflow state' }
  const workflows = parsed.data
  if (Object.keys(workflows).length > MAX_WORKFLOWS)
    return { accepted: false, reason: 'workflow state capacity exceeded' }
  const key = `${input.repository.toLowerCase()}#${input.workflowId}`
  const previous = workflows[key]
  if (previous) {
    const run = BigInt(input.runNumber) - BigInt(previous.runNumber)
    if (run === 0n && input.runId !== previous.runId)
      return { accepted: false, reason: 'inconsistent workflow run identity' }
    if (run === 0n && input.runAttempt === previous.runAttempt)
      return { accepted: false, reason: `already notified for run ${input.runId} / attempt ${input.runAttempt}` }
    if (run === 0n && BigInt(input.runAttempt) < BigInt(previous.runAttempt))
      return {
        accepted: false,
        reason: `stale run ${input.runId} attempt ${input.runAttempt}; latest notified attempt is ${previous.runAttempt}`,
      }
    if (run < 0n) return { accepted: false, reason: 'older workflow run' }
  } else if (Object.keys(workflows).length >= MAX_WORKFLOWS) {
    return { accepted: false, reason: 'workflow state capacity reached' }
  }
  // Never evict a watermark: deletion/rename is not evidence that deliveries
  // have stopped. Compact tombstones live with the work stream, independent of
  // inbox message retention. New partitions fail closed at the fixed cap.
  workflows[key] = {
    runId: input.runId,
    runNumber: input.runNumber,
    runAttempt: input.runAttempt,
    conclusion: input.conclusion,
  }
  return { accepted: true, workflows }
}
