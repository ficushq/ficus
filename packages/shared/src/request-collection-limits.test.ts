import { workflowDefinitionShapeSchema, workflowStepSchema, workflowEventTriggerSchema } from './workflows'
import { expect, test } from 'bun:test'
import { z } from 'zod'
import * as schemas from './schemas'
import {
  decisionQuestionsSchema,
  decisionQuestionSchema,
  decisionRequestSchema,
  decisionFeatureSwitchesSchema,
  decisionRoutingSchema,
  DECISION_PURPOSES,
} from './decisions'
import { integrationMatchSchema } from './integration-outputs'
import { syntheticEventSampleSchema } from './event-rule-sample'
import { squadEventRulesSchema } from './squad-event-rules'
import { themeOperationSchema, themeInsightsVariantSchema } from './theme-assistant'
import { assistantEditorReadSchema } from './assistant-editors'

const map = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`key_${i}`, null]))
function overflow(schema: z.ZodType, value: unknown, maximum: number) {
  const result = schema.safeParse(value)
  expect(result.success).toBe(false)
  if (!result.success) expect(result.error.issues).toMatchObject([{ code: 'too_big', maximum }])
}
for (const [name, schema, maximum] of [
  ['create defaultAgents', schemas.createSquadSchema.shape.defaultAgents, 100],
  ['update defaultAgents', schemas.updateSquadSchema.shape.defaultAgents, 100],
  ['reorder ids', schemas.reorderSquadsSchema.shape.ids, 1000],
  ['prompt options', schemas.workStreamPromptSchema.shape.options, 100],
  ['prompt files', schemas.workStreamPromptSchema.shape.files, 1000],
  ['create agents', schemas.createWorkStreamSchema.shape.agentIds, 100],
  ['legacy agents', schemas.createWorkStreamSchema.shape.agents, 100],
  ['create dependencies', schemas.createWorkStreamSchema.shape.dependsOn, 100],
  ['update agents', schemas.updateWorkStreamSchema.shape.agentIds, 100],
  ['update dependencies', schemas.updateWorkStreamSchema.shape.dependsOn, 100],
  ['update files', schemas.updateWorkStreamSchema.shape.files, 1000],
  ['attachments', schemas.sendInboxMessageSchema.shape.attachmentIds, 100],
  ['editor include', assistantEditorReadSchema.shape.include, 3],
] as const)
  test(name + ' refuses oversized arrays before child issues', () =>
    overflow(schema, Array(maximum + 1).fill(null), maximum)
  )
for (const [name, schema, maximum] of [
  ['create typeContext', schemas.createSquadSchema.shape.typeContext, 256],
  ['update typeContext', schemas.updateSquadSchema.shape.typeContext, 256],
  ['squad metadata', schemas.squadMetadataSchema, 256],
  ['relationship metadata', schemas.createSquadRelationshipSchema.shape.metadata, 256],
  ['create metadata', schemas.createWorkStreamSchema.shape.metadata, 256],
  ['update metadata', schemas.updateWorkStreamSchema.shape.metadata, 256],
  ['legacy overrides', schemas.createWorkStreamSchema.shape.agentModelOverrides, 256],
  ['inbox metadata', schemas.sendInboxMessageSchema.shape.metadata, 256],
  ['decision questions', decisionQuestionsSchema, 64],
  ['choice options', decisionQuestionSchema.options[1].shape.options, 64],
  ['decision features', decisionFeatureSwitchesSchema, DECISION_PURPOSES.length],
  ['decision purposes', decisionRoutingSchema.shape.purposes, DECISION_PURPOSES.length],
  ['matches', integrationMatchSchema, 16],
  ['sample fields', syntheticEventSampleSchema.shape.fields, 32],
  ['provider rules', squadEventRulesSchema, 256],
  ['theme tokens', themeOperationSchema.options[1].shape.tokens, 64],
  ['theme colors', themeInsightsVariantSchema.shape.keyColors, 8],
] as const)
  test(name + ' refuses oversized maps before child issues', () => overflow(schema, map(maximum + 1), maximum))
test('decision state arrays and maps are bounded', () => {
  for (const state of [map(257), Array(1001).fill(null)]) {
    const result = decisionRequestSchema.safeParse({ state, questions: { ok: { type: 'yesno', instructions: 'ok' } } })
    expect(result.success).toBe(false)
  }
})

test('workflow maps reject before child parsing', () => {
  overflow(workflowDefinitionShapeSchema.shape.participants, map(65), 64)
  overflow(workflowEventTriggerSchema.shape.match, map(17), 16)
  overflow(workflowEventTriggerSchema.shape.create.shape.metadata, map(17), 16)
  const result = workflowStepSchema.safeParse({
    kind: 'agent',
    id: 'step',
    participant: 'owner',
    instructions: 'ok',
    output: 'ok',
    outcomes: map(17),
  })
  expect(result.success).toBe(false)
  if (!result.success) expect(JSON.stringify(result.error.issues)).toContain('too_big')
})
