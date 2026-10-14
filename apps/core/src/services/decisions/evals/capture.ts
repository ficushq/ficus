import { and, count, desc, eq, inArray, notInArray } from 'drizzle-orm'
import type { DecisionAnswer, DecisionPurpose, DecisionRequest } from '@ficus/shared'
import { db, decisionEvalCandidates } from '../../../db'
import { createLogger } from '../../../lib/infra/logger'
import { isPlatformManaged } from '../../secrets'
import { getSettingsStore } from '../../settings'

const log = createLogger('decision-eval-capture')

/** The instance setting; off unless someone turns it on. */
export const DECISION_EVAL_CAPTURE_KEY = 'DECISION_EVAL_CAPTURE'
/** Only the newest this many candidates are kept. */
export const MAX_DECISION_EVAL_CANDIDATES = 500

export interface EvalCaptureState {
  /** False on hosted tenants: their users' text is never kept for evals. */
  available: boolean
  enabled: boolean
  /** Candidates waiting for review. */
  pending: number
}

/** Whether corrections are saved as candidate eval cases: opt-in, never on hosted tenants. */
export function isEvalCaptureEnabled(): boolean {
  return !isPlatformManaged() && getSettingsStore().getStoredValue(DECISION_EVAL_CAPTURE_KEY) === 'true'
}

export async function evalCaptureState(): Promise<EvalCaptureState> {
  const available = !isPlatformManaged()
  const [row] = available
    ? await db.select({ pending: count() }).from(decisionEvalCandidates).where(eq(decisionEvalCandidates.status, 'new'))
    : []
  return { available, enabled: isEvalCaptureEnabled(), pending: Number(row?.pending ?? 0) }
}

export class EvalCaptureUnavailableError extends Error {
  constructor() {
    super('Saving corrections as eval cases is not available on hosted instances')
    this.name = 'EvalCaptureUnavailableError'
  }
}

export async function setEvalCapture(enabled: boolean, actor?: string) {
  if (enabled && isPlatformManaged()) throw new EvalCaptureUnavailableError()
  await getSettingsStore().set(DECISION_EVAL_CAPTURE_KEY, enabled ? 'true' : 'false', actor)
}

export interface CorrectionCapture {
  /** The eval it is a case for (its `name`). */
  evalName: string
  purpose: DecisionPurpose
  /** Builds the request the way the feature does; only called while capture is on. */
  build: () => Promise<{ request: DecisionRequest; context?: unknown } | null>
  /** What the user said was right, in the eval's outcome terms. */
  expect?: unknown
  accept?: unknown[]
  modelAnswers?: Record<string, DecisionAnswer>
  /** A one-line preview: what was asked and what the user chose. */
  summary: string
  source?: Record<string, string>
}

/** Save a correction as a candidate case when capture is on. Never throws and never blocks the caller's work. */
export async function captureCorrection(capture: CorrectionCapture): Promise<void> {
  try {
    if (!isEvalCaptureEnabled()) return
    const built = await capture.build()
    if (!built) return
    await db.insert(decisionEvalCandidates).values({
      evalName: capture.evalName,
      purpose: capture.purpose,
      request: built.request,
      context: built.context ?? null,
      expected: {
        ...(capture.expect !== undefined ? { expect: capture.expect } : {}),
        ...(capture.accept ? { accept: capture.accept } : {}),
      },
      modelAnswers: capture.modelAnswers ?? null,
      summary: capture.summary.replace(/\s+/g, ' ').trim().slice(0, 300),
      source: capture.source ?? null,
    })
    const keep = db
      .select({ id: decisionEvalCandidates.id })
      .from(decisionEvalCandidates)
      .orderBy(desc(decisionEvalCandidates.createdAt))
      .limit(MAX_DECISION_EVAL_CANDIDATES)
    await db.delete(decisionEvalCandidates).where(notInArray(decisionEvalCandidates.id, keep))
  } catch (error) {
    log.warn('Could not save a correction as an eval candidate', error)
  }
}

/** For the inbox: candidates by status, newest first. */
export async function listCandidates(statuses: Array<'new' | 'accepted' | 'dismissed'> = ['new']) {
  return db
    .select()
    .from(decisionEvalCandidates)
    .where(inArray(decisionEvalCandidates.status, statuses))
    .orderBy(desc(decisionEvalCandidates.createdAt))
}

export async function setCandidateStatus(id: string, status: 'accepted' | 'dismissed') {
  const [row] = await db
    .update(decisionEvalCandidates)
    .set({ status })
    .where(and(eq(decisionEvalCandidates.id, id), eq(decisionEvalCandidates.status, 'new')))
    .returning()
  return row ?? null
}
