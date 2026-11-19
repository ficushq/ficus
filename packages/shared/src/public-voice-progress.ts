/** Request-owned, versioned voice progress. No sample or model-delta payload exists. */
import { z } from 'zod'
import {
  DERIVATION_SURFACES,
  PUBLIC_SURFACES,
  derivationFiltersSchema,
  publicVoiceSurfacesSchema,
} from './public-voice'
import { safeDerivationReason } from './public-voice-errors'

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
export const progressRepositorySchema = z
  .string()
  .min(3)
  .max(140)
  .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)
export const DROP_REASONS = [
  'date',
  'repository',
  'tool_authored',
  'template_or_short',
  'surface_limit',
  'sample_limit',
  'input_byte_limit',
] as const
const dropped = z
  .object(
    Object.fromEntries(DROP_REASONS.map((key) => [key, count])) as Record<(typeof DROP_REASONS)[number], typeof count>
  )
  .strict()
export const progressCountsSchema = z.object({ seen: count, kept: count, dropped }).strict()
export type ProgressCounts = z.infer<typeof progressCountsSchema>
export const samplingBreakdownSchema = z
  .object({
    totals: progressCountsSchema,
    bySurface: z
      .object({
        'pull-requests': progressCountsSchema,
        'issue-comments': progressCountsSchema,
        reviews: progressCountsSchema,
        commits: progressCountsSchema,
      })
      .strict(),
    pagingCapped: z.boolean(),
  })
  .strict()
  .refine((snapshot) => {
    const rows = Object.values(snapshot.bySurface)
    const reconciles = (row: z.infer<typeof progressCountsSchema>) =>
      row.seen === row.kept + Object.values(row.dropped).reduce((a, b) => a + b, 0)
    return (
      [...rows, snapshot.totals].every(reconciles) &&
      rows.reduce((n, row) => n + row.seen, 0) === snapshot.totals.seen &&
      rows.reduce((n, row) => n + row.kept, 0) === snapshot.totals.kept &&
      DROP_REASONS.every(
        (reason) => rows.reduce((n, row) => n + row.dropped[reason], 0) === snapshot.totals.dropped[reason]
      )
    )
  }, 'Sampling counts must reconcile')
export type SamplingBreakdown = z.infer<typeof samplingBreakdownSchema>
export function emptyProgressCounts(): ProgressCounts {
  return {
    seen: 0,
    kept: 0,
    dropped: {
      date: 0,
      repository: 0,
      tool_authored: 0,
      template_or_short: 0,
      surface_limit: 0,
      sample_limit: 0,
      input_byte_limit: 0,
    },
  }
}
export function emptySamplingBreakdown(): SamplingBreakdown {
  return {
    totals: emptyProgressCounts(),
    bySurface: Object.fromEntries(
      DERIVATION_SURFACES.map((s) => [s, emptyProgressCounts()])
    ) as SamplingBreakdown['bySurface'],
    pagingCapped: false,
  }
}
const samplingCountsSchema = z
  .object({
    collected: count,
    kept: count,
    droppedByFilter: z.object({ date: count, repository: count }).strict(),
    droppedAsToolAuthored: count,
    droppedAsTemplate: count,
  })
  .strict()
export const voiceDerivationResultSchema = z
  .object({
    login: z.string().max(39),
    draft: z.object({ base: z.string().max(2000), surfaces: publicVoiceSurfacesSchema }).strict(),
    observations: z.array(z.string().min(1).max(160)).max(12),
    exemplars: z
      .array(
        z
          .object({ surface: z.enum(PUBLIC_SURFACES), text: z.string().max(240), repository: progressRepositorySchema })
          .strict()
      )
      .max(6),
    sampling: z
      .object({
        filters: derivationFiltersSchema,
        counts: samplingCountsSchema,
        dateRange: z.record(z.string(), z.object({ oldest: z.string().max(10), newest: z.string().max(10) }).strict()),
        publicRepositories: z.array(progressRepositorySchema).max(120),
        privateRepositories: z.array(progressRepositorySchema).max(120),
        pagingCapped: z.boolean(),
        unavailableRepositories: z.array(progressRepositorySchema).max(50).optional(),
        commitRepositoriesNotSampled: z.array(progressRepositorySchema).max(50).optional(),
        toolAuthoredIsHeuristic: z.literal(true).optional(),
        breakdown: samplingBreakdownSchema.optional(),
      })
      .strict(),
    bytes: count.max(2000),
    maxBytes: z.literal(2000),
  })
  .strict()
export type VoiceDerivationResult = z.infer<typeof voiceDerivationResultSchema>
const failureCodes = [
  'derivation_github_unavailable',
  'derivation_login_not_visible',
  'derivation_too_few_samples',
  'derivation_invalid_output',
  'derivation_model_unavailable',
  'derivation_timed_out',
  'derivation_stream_interrupted',
  'derivation_failed',
] as const
const failureCountsSchema = samplingCountsSchema.partial().required({ collected: true, kept: true })
export const safeDerivationFailureSchema = z
  .object({
    code: z.enum(failureCodes),
    reason: z.string().max(32).optional(),
    counts: failureCountsSchema.optional(),
    minimum: count.optional(),
  })
  .strict()
  .refine((f) => !f.reason || safeDerivationReason(f.code, f.reason) === f.reason)
export type SafeDerivationFailure = z.infer<typeof safeDerivationFailureSchema>
/** Never spread exception details onto the wire. */
export function safeDerivationFailure(code: string, details: Record<string, unknown> = {}): SafeDerivationFailure {
  const known = z.enum(failureCodes).safeParse(code)
  const result: SafeDerivationFailure = { code: known.success ? known.data : 'derivation_failed' }
  if (details.reason !== undefined) result.reason = safeDerivationReason(code, details.reason)
  const counts = failureCountsSchema.safeParse(details.counts)
  if (counts.success) result.counts = counts.data
  const minimum = count.safeParse(details.minimum)
  if (minimum.success) result.minimum = minimum.data
  return result
}
const envelope = {
  version: z.literal(1),
  runId: z
    .string()
    .min(1)
    .max(80)
    .regex(/^[A-Za-z0-9-]+$/),
  seq: count,
}
export const derivationEventSchema = z
  .discriminatedUnion('type', [
    z.object({ ...envelope, type: z.literal('started') }).strict(),
    z
      .object({
        ...envelope,
        type: z.literal('phase'),
        phase: z.enum(['collecting', 'sampling', 'drafting', 'validating']),
      })
      .strict(),
    z
      .object({
        ...envelope,
        type: z.literal('repositories'),
        repositories: z
          .array(
            z
              .object({
                name: progressRepositorySchema,
                activity: z.enum(['activity_read', 'reading_commits', 'commits_read', 'unavailable', 'commit_limit']),
              })
              .strict()
          )
          .max(20),
      })
      .strict(),
    z
      .object({ ...envelope, type: z.literal('counts'), provisional: z.boolean(), ...samplingBreakdownSchema.shape })
      .strict(),
    z
      .object({
        ...envelope,
        type: z.literal('finding'),
        index: count.max(11),
        text: z
          .string()
          .min(1)
          .max(160)
          // eslint-disable-next-line no-control-regex -- Findings cannot carry terminal controls.
          .regex(/^[^\u0000-\u001f\u007f]*$/),
      })
      .strict(),
    z.object({ ...envelope, type: z.literal('complete'), result: voiceDerivationResultSchema }).strict(),
    z.object({ ...envelope, type: z.literal('error'), error: safeDerivationFailureSchema }).strict(),
  ])
  .refine(
    (event) =>
      event.type !== 'counts' ||
      samplingBreakdownSchema.safeParse({
        totals: event.totals,
        bySurface: event.bySurface,
        pagingCapped: event.pagingCapped,
      }).success,
    'Sampling counts must reconcile'
  )
export type DerivationEvent = z.infer<typeof derivationEventSchema>
export type DerivationProgress = DerivationEvent extends infer E
  ? E extends DerivationEvent
    ? Omit<E, 'version' | 'runId' | 'seq'>
    : never
  : never
export type PublishDerivationProgress = (event: DerivationProgress) => Promise<void>
