import { expect, test } from 'bun:test'
import {
  WORKFLOW_REVIEW_REVISED_MESSAGE,
  sameWorkflowReviewedRevisions,
  workflowAttemptResults,
  workflowCurrentAttachmentIds,
  workflowResultChanges,
} from './workflow-result-revisions'
import type { WorkflowAttemptAttachment } from './workflow-attachments'
import type { WorkflowAttempt } from './workflow-runtime'
import { brief } from './test-fixtures/workflow-review'

const file = (id: string, path: string, revision = 1): WorkflowAttemptAttachment => ({
  id,
  attemptId: 1,
  filename: path.split('/').pop()!,
  path,
  contentType: 'text/markdown',
  byteSize: 10,
  createdAt: '2026-10-30T12:00:00.000Z',
  revision,
})

test('the refusal message is exact', () => {
  expect(WORKFLOW_REVIEW_REVISED_MESSAGE).toBe('This was revised since you opened it. Review the latest revision.')
})

test('a legacy attempt is one revision 1 with its revision-1 files; staged files are not current', () => {
  const attempt: WorkflowAttempt = { id: 1, stepId: 'design', status: 'completed', evidence: 'Evidence.' }
  const rows = [file('a', 'docs/design.md'), file('b', 'docs/plan.md'), file('s', 'docs/draft.md', 2)]
  expect(workflowCurrentAttachmentIds(attempt, rows)).toEqual(['a', 'b'])
  expect(workflowAttemptResults(attempt, rows)).toEqual([
    { revision: 1, evidence: 'Evidence.', attachmentIds: ['a', 'b'] },
  ])
})

test('an amended attempt lists earlier revisions then the current one', () => {
  const attempt: WorkflowAttempt = {
    id: 1,
    stepId: 'design',
    status: 'completed',
    settledVersion: 1,
    evidence: 'Second.',
    resultRevision: 2,
    resultRevisedVersion: 4,
    resultRevisedAt: '2026-10-30T12:05:00.000Z',
    attachmentIds: ['c'],
    earlierResults: [{ revision: 1, version: 1, evidence: 'First.', attachmentIds: ['a'] }],
  }
  expect(workflowAttemptResults(attempt, [])).toEqual([
    { revision: 1, version: 1, evidence: 'First.', attachmentIds: ['a'] },
    { revision: 2, version: 4, recordedAt: '2026-10-30T12:05:00.000Z', evidence: 'Second.', attachmentIds: ['c'] },
  ])
})

test('changes list brief fields, evidence and attachments added, removed and changed', () => {
  const files = Object.fromEntries(
    [
      file('a', 'docs/design.md'),
      file('b', 'docs/plan.md'),
      file('c', 'docs/old.md'),
      file('a2', 'docs/design.md', 2),
      file('d', 'docs/new.md', 2),
    ].map((f) => [f.id, f])
  )
  const changes = workflowResultChanges(
    {
      evidence: 'One.',
      decisionBrief: { value: brief, submittedVersion: 1, contexts: [] },
      attachmentIds: ['a', 'b', 'c'],
    },
    {
      evidence: 'Two.',
      decisionBrief: {
        value: { ...brief, risks: 'A new risk sentence.', changesSinceLastReview: 'Added a rollback note.' },
        submittedVersion: 2,
        contexts: [],
      },
      attachmentIds: ['a2', 'b', 'd'],
    },
    files
  )
  expect(changes.briefFields).toEqual([
    { field: 'risks', before: brief.risks, after: 'A new risk sentence.' },
    { field: 'changesSinceLastReview', after: 'Added a rollback note.' },
  ])
  expect(changes.unchangedBriefFields).toEqual(['decision', 'recommendation', 'approvalEffect'])
  expect(changes.evidenceChanged).toBe(true)
  expect(changes.attachments.added.map((f) => f.id)).toEqual(['d'])
  expect(changes.attachments.removed.map((f) => f.id)).toEqual(['c'])
  expect(changes.attachments.changed.map((c) => [c.before.id, c.after.id])).toEqual([['a', 'a2']])
})

test('reviewed revision sets compare without order', () => {
  expect(
    sameWorkflowReviewedRevisions(
      [
        { attemptId: 2, revision: 1 },
        { attemptId: 3, revision: 2 },
      ],
      [
        { attemptId: 3, revision: 2 },
        { attemptId: 2, revision: 1 },
      ]
    )
  ).toBe(true)
  expect(sameWorkflowReviewedRevisions([{ attemptId: 2, revision: 1 }], [{ attemptId: 2, revision: 2 }])).toBe(false)
  expect(sameWorkflowReviewedRevisions([], [{ attemptId: 2, revision: 1 }])).toBe(false)
})
