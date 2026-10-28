import { z } from 'zod'
import { boundedRecord, keyedRecord } from './zod-helpers'
import { eventPredicateFields, eventPredicateField } from './event-predicate-catalog'
import {
  integrationDataPathSchema,
  integrationSubscriptionSchema,
  type IntegrationOutputFact,
} from './integration-outputs'

/** Synthetic, user-entered facts only. Flat allowlisted paths avoid exposing stored provider payloads. */
export const syntheticEventSampleSchema = z
  .object({
    source: integrationSubscriptionSchema.shape.source,
    fields: boundedRecord(
      keyedRecord(
        integrationDataPathSchema,
        z.union([
          z.string().max(2000),
          z.number().finite(),
          z.boolean(),
          z.array(z.string().max(2000)).max(100),
          z.null(),
        ])
      ),
      32
    ).refine((fields) => Object.keys(fields).length <= 32, 'Use at most 32 sample fields'),
    login: z
      .string()
      .max(100)
      .regex(/^[a-zA-Z0-9_-]*$/)
      .default(''),
    mentioned: z.boolean().default(false),
  })
  .strict()
  .superRefine((sample, ctx) => {
    const fields = eventPredicateFields(sample.source)
    if (!fields) ctx.addIssue({ code: 'custom', path: ['source'], message: 'Unsupported sample event version' })
    for (const [path, value] of Object.entries(sample.fields)) {
      const field = eventPredicateField(sample.source, path)
      if (!field)
        ctx.addIssue({ code: 'custom', path: ['fields', path], message: 'Unsupported sample field for this event' })
      else if (value !== null && (field.type === 'string[]' ? !Array.isArray(value) : typeof value !== field.type))
        ctx.addIssue({ code: 'custom', path: ['fields', path], message: `Sample field requires ${field.type} or null` })
    }
  })
export type SyntheticEventSample = z.infer<typeof syntheticEventSampleSchema>
export function syntheticEventFact(input: SyntheticEventSample): IntegrationOutputFact {
  const sample = syntheticEventSampleSchema.parse(input)
  const data: Record<string, unknown> = {}
  for (const [path, value] of Object.entries(sample.fields)) {
    const parts = path.split('.')
    let target = data
    for (const part of parts.slice(0, -1)) target = (target[part] ??= {}) as Record<string, unknown>
    target[parts.at(-1)!] = value
  }
  return {
    output: sample.source.output,
    version: sample.source.version,
    data,
    eventKey: 'synthetic',
    resourceKey: 'synthetic',
    occurredAt: '2000-01-01T00:00:00.000Z',
    subject: 'Synthetic sample',
    body: sample.mentioned && sample.login ? `@${sample.login}` : '',
  }
}
