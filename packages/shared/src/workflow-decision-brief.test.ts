import { describe, expect, test } from 'bun:test'
import { workflowCommandSchema } from './workflow-runtime'

import { brief } from './test-fixtures/workflow-review'

const parse = (value: unknown) =>
  workflowCommandSchema.safeParse({
    action: 'complete',
    expectedVersion: 0,
    attemptId: 1,
    outcome: 'ready',
    evidence: 'Audit record.',
    decisionBrief: value,
  })
describe('decision brief input', () => {
  test('retains the structured brief separately from evidence', () => {
    expect(parse(brief)).toMatchObject({ success: true, data: { decisionBrief: brief, evidence: 'Audit record.' } })
  })
  for (const field of [...Object.keys(brief), 'changesSinceLastReview']) {
    test(`${field} rejects compressed prose, literal-only text, controls and invalid shapes`, () => {
      for (const value of [
        '',
        null,
        1,
        'Please approveTheExactRetryPacket before implementation.',
        'Approve.This is ready.',
        'pls approve this',
        '`cache-stage-example`',
        'This contains\u200b hidden separators.',
      ]) {
        expect(parse({ ...brief, [field]: value }).success).toBe(false)
      }
    })
    test(`${field} preserves literal data in explanatory prose`, () => {
      for (const value of [
        'Approve the API plan for `approveTheExactRetryPacket` and /tmp/stage/config.json.',
        'The source says "pls approveTheExactRetryPacket"; use https://example.test/v1.2 for the actual API.',
        '正常な説明を使用します。',
      ]) {
        expect(parse({ ...brief, [field]: value }).success).toBe(true)
      }
    })
  }
  test('bounds every field and rejects unknown keys', () => {
    for (const [field, max] of Object.entries({
      decision: 500,
      recommendation: 1000,
      approvalEffect: 2400,
      risks: 1600,
      changesSinceLastReview: 2000,
    })) {
      const value = 'Approve the staging design' + ' for staging'.repeat(300)
      expect(parse({ ...brief, [field]: value.slice(0, max) }).success).toBe(true)
      expect(parse({ ...brief, [field]: value.slice(0, max + 1) }).success).toBe(false)
    }
    expect(parse({ ...brief, extra: 'No extra fields.' }).success).toBe(false)
  })
  test('decision is one or two plain sentences, not a list', () => {
    for (const decision of [
      'Approve the design. Keep the fallback. Review the rollout.',
      '- Approve the design.',
      '# Approve the design',
    ]) {
      expect(parse({ ...brief, decision }).success).toBe(false)
    }
    expect(parse({ ...brief, decision: 'Approve version 1.2 of the staging API. Keep the fallback.' }).success).toBe(
      true
    )
  })
})

test('shorthand outside literals is rejected in every field; normal abbreviations remain prose', () => {
  for (const field of ['decision', 'recommendation', 'approvalEffect', 'risks', 'changesSinceLastReview']) {
    for (const token of ['pls', 'plz', 'thx', 'apprv', 'reqd', 'rdy', 'b4', 'w/', 'w/o', 'b/c'])
      expect(parse({ ...brief, [field]: `Approve the design ${token} staging work.` }).success).toBe(false)
    expect(parse({ ...brief, [field]: 'Approve the design, e.g. the staging API v1.2, after review.' }).success).toBe(
      true
    )
    expect(
      parse({ ...brief, [field]: "The source says 'pls approveTheExactRetryPacket'; review the full design." }).success
    ).toBe(true)
  }
})
