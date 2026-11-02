import { describe, expect, test } from 'bun:test'
import {
  WORKFLOW_REVIEW_REVISED_MESSAGE,
  WORKFLOW_REVIEW_SOURCE_ADDED_LABEL,
  WORKFLOW_REVIEW_SOURCE_ADDED_MESSAGE,
  sameWorkflowReviewedRevisions,
  workflowAttemptResults,
  workflowChangesSinceSeen,
  workflowCurrentAttachmentIds,
  workflowMarkRevisionsSeen,
  workflowResultChanges,
  workflowReviewDecisionRefusal,
  workflowReviewSeenState,
  workflowReviewUnseenMessage,
  workflowSeenRevisionsAtOpen,
  workflowUnseenLabel,
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

describe('seen revisions on a review screen', () => {
  const now = new Date('2026-10-30T12:10:00.000Z').getTime()

  test('sources present when the review opens are seen at their opened revision', () => {
    const current = [
      { attemptId: 2, revision: 1 },
      { attemptId: 3, revision: 2 },
    ]
    const seen = workflowSeenRevisionsAtOpen(current)
    expect(seen).toEqual({ '2': 1, '3': 2 })
    expect(workflowReviewSeenState(current, seen)).toEqual({ unseen: [], reviewed: current })
    expect(workflowReviewUnseenMessage([])).toBeNull()
    // The decision names exactly the current revisions, so Core accepts it.
    expect(workflowReviewDecisionRefusal(current, current, 5)).toBeNull()
  })

  test('a revision after opening is unseen until marked reviewed, and the decision names the seen revision', () => {
    const seen = workflowSeenRevisionsAtOpen([{ attemptId: 2, revision: 1 }])
    const current = [{ attemptId: 2, revision: 2 }]
    const state = workflowReviewSeenState(current, seen)
    expect(state).toEqual({
      unseen: [{ attemptId: 2, revision: 2, seenRevision: 1 }],
      reviewed: [{ attemptId: 2, revision: 1 }],
    })
    expect(workflowReviewUnseenMessage(state.unseen)).toBe(WORKFLOW_REVIEW_REVISED_MESSAGE)
    expect(workflowUnseenLabel(state.unseen[0]!, '2026-10-30T12:08:00.000Z', now)).toBe('Revised 2 min ago')
    expect(workflowReviewDecisionRefusal(state.reviewed, current, 5)).toBe(WORKFLOW_REVIEW_REVISED_MESSAGE)
    const marked = workflowReviewSeenState(current, workflowMarkRevisionsSeen(seen, current))
    expect(marked).toEqual({ unseen: [], reviewed: current })
    expect(workflowReviewDecisionRefusal(marked.reviewed, current, 5)).toBeNull()
  })

  test('a source that starts feeding the gate after opening is new and unseen, and the decision leaves it out', () => {
    // The screen opened with source 2 only; source 3 (for example a join branch) appeared afterwards.
    const seen = workflowSeenRevisionsAtOpen([{ attemptId: 2, revision: 1 }])
    const current = [
      { attemptId: 2, revision: 1 },
      { attemptId: 3, revision: 1 },
    ]
    const state = workflowReviewSeenState(current, seen)
    expect(state).toEqual({ unseen: [{ attemptId: 3, revision: 1 }], reviewed: [{ attemptId: 2, revision: 1 }] })
    expect(workflowReviewUnseenMessage(state.unseen)).toBe(WORKFLOW_REVIEW_SOURCE_ADDED_MESSAGE)
    expect(workflowUnseenLabel(state.unseen[0]!, undefined, now)).toBe(WORKFLOW_REVIEW_SOURCE_ADDED_LABEL)
    // Core refuses a decision that omits a current source.
    expect(workflowReviewDecisionRefusal(state.reviewed, current, 5)).toBe(WORKFLOW_REVIEW_REVISED_MESSAGE)
    const marked = workflowReviewSeenState(current, workflowMarkRevisionsSeen(seen, current))
    expect(marked).toEqual({ unseen: [], reviewed: current })
    expect(workflowReviewDecisionRefusal(marked.reviewed, current, 5)).toBeNull()
  })

  test('a new source alongside a revised one shows the revised notice', () => {
    const unseen = workflowReviewSeenState(
      [
        { attemptId: 2, revision: 2 },
        { attemptId: 3, revision: 1 },
      ],
      { '2': 1 }
    ).unseen
    expect(workflowReviewUnseenMessage(unseen)).toBe(WORKFLOW_REVIEW_REVISED_MESSAGE)
  })

  test('what an earlier opening stored wins over what is on screen now', () => {
    expect(
      workflowSeenRevisionsAtOpen(
        [
          { attemptId: 2, revision: 3 },
          { attemptId: 3, revision: 1 },
        ],
        { '2': 1 }
      )
    ).toEqual({ '2': 1, '3': 1 })
  })

  const submitted = { value: brief, submittedVersion: 1, contexts: [] }

  test('changes since seen compare with the seen revision, or list everything for a new source', () => {
    const attempt: WorkflowAttempt = {
      id: 1,
      stepId: 'design',
      status: 'completed',
      evidence: 'Second.',
      decisionBrief: submitted,
      resultRevision: 2,
      attachmentIds: ['b'],
      earlierResults: [{ revision: 1, evidence: 'First.', decisionBrief: submitted, attachmentIds: ['a'] }],
    }
    const rows = [file('a', 'docs/design.md'), file('b', 'docs/design.md', 2)]
    const revised = workflowChangesSinceSeen(attempt, rows, 1)
    expect(revised.before?.revision).toBe(1)
    expect(revised.after.revision).toBe(2)
    expect(revised.changes.briefFields).toEqual([])
    expect(revised.changes.evidenceChanged).toBe(true)
    expect(revised.changes.attachments.changed.map((entry) => entry.after.id)).toEqual(['b'])
    const added = workflowChangesSinceSeen(attempt, rows, undefined)
    expect(added.before).toBeUndefined()
    expect(added.changes.attachments.added.map((entry) => entry.id)).toEqual(['b'])
    expect(added.changes.evidenceChanged).toBe(true)
  })
})
