import type { EventPredicateField } from './event-predicate-catalog'
import { z } from 'zod'
import { boundedRecord, keyedRecord } from './zod-helpers'

const name = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[a-z][a-z0-9_.-]*$/)
export const integrationDataPathSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)*$/)
  .refine(
    (path) => path.split('.').every((part) => !['__proto__', 'prototype', 'constructor'].includes(part)),
    'Reserved path'
  )
export const integrationMatchSchema = boundedRecord(
  keyedRecord(
    integrationDataPathSchema,
    z.union([
      z.strictObject({ streamMetadata: integrationDataPathSchema }),
      z.strictObject({ value: z.union([z.string().max(2000), z.number().finite(), z.boolean()]) }),
    ])
  ),
  16
).refine((value) => Object.keys(value).length > 0 && Object.keys(value).length <= 16, 'Use 1–16 equality matches')
export const integrationSubscriptionSchema = z.strictObject({
  id: name,
  source: z.strictObject({
    integration: name,
    output: name,
    version: z.int().positive(),
    connectionId: z.uuid().optional(),
  }),
  match: integrationMatchSchema,
  deliver: z.strictObject({
    to: z.union([
      z.strictObject({ participant: name }),
      z.strictObject({ step: name }),
      z.literal('active'),
      z.literal('delivery-owner'),
    ]),
    whenInactive: z.enum(['retain', 'manager']).default('retain'),
  }),
})
export type IntegrationSubscription = z.infer<typeof integrationSubscriptionSchema>
export type IntegrationOutputField = {
  type: 'string' | 'number' | 'boolean'
  normalize?: 'lowercase'
  description: string
}
export interface IntegrationOutputDescriptor {
  integration: string
  output: string
  version: number
  title: string
  description: string
  fields: Record<string, IntegrationOutputField>
  predicateFields?: Record<string, EventPredicateField>
}
export interface IntegrationOutputFact {
  output: string
  version: number
  eventKey: string
  resourceKey: string
  occurredAt: string
  data: Record<string, unknown>
  subject: string
  body: string
  url?: string
  /** Server-normalized GitHub projections; raw data remains internal matching evidence. */
  github?: import('./github-feedback').GitHubFeedbackEnvelope
  /** Lexicographic monotonic position, e.g. CI run number then attempt. */
  ordering?: { key: string; position: number[] }
}

export function integrationValueAt(value: unknown, path: string): unknown {
  for (const part of path.split('.')) {
    if (!value || typeof value !== 'object' || !Object.hasOwn(value, part)) return undefined
    value = (value as Record<string, unknown>)[part]
  }
  return value
}
export function integrationSubscriptionMatches(
  subscription: IntegrationSubscription,
  fact: IntegrationOutputFact,
  metadata: unknown,
  descriptor: IntegrationOutputDescriptor
): boolean {
  return Object.entries(subscription.match).every(([path, binding]) => {
    const field = descriptor.fields[path]
    if (!field) return false
    const actual = integrationValueAt(fact.data, path)
    const expected = 'value' in binding ? binding.value : integrationValueAt(metadata, binding.streamMetadata)
    if (typeof actual !== field.type || typeof expected !== field.type) return false
    return field.normalize === 'lowercase' && typeof actual === 'string' && typeof expected === 'string'
      ? actual.toLowerCase() === expected.toLowerCase()
      : actual === expected
  })
}

export interface IntegrationDeliveryView {
  id: string
  subscriptionId: string
  status: 'pending' | 'queued' | 'delivered' | 'superseded'
  reason: string | null
  targets: Array<{ agentId: string; attemptId?: number; version?: number; inboxId: string }>
  createdAt: string
  fact: IntegrationOutputFact
  integration: string
}
