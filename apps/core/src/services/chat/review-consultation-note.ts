import type { WorkflowReviewConsultation } from '@ficus/shared'

/**
 * The model-only context a producing agent gets with each message a person sends it from the
 * review screen of an open human approval gate. It names the gate and the attempts under review,
 * says the person is deciding now, and sets the bounds: answer and cite evidence, refine only with
 * amend, and recommend Changes requested for anything bigger.
 */
export function reviewConsultationNote(context: WorkflowReviewConsultation): string {
  const ref = context.workStreamRef
  const sources = context.sources
    .map((source) => `your ${source.stepId} attempt ${source.attemptId}, revision ${source.revision}`)
    .join('; ')
  const attemptIds = context.sources.map((source) => source.attemptId).join(' or ')
  const amend = context.amend.available
    ? `For a refinement they ask for, make the change on the stream's branch, commit it, refresh \`ficus workstream flow ${ref}\`, then send \`ficus workstream advance ${ref}\` with action "amend", the current expectedVersion, attemptId ${attemptIds}, the complete revised decisionBrief and evidence naming the commit SHAs, and --attach for added or replaced files. Amending keeps the gate open and is not a new review round. If a request is too big for a refinement, such as a new approach, a security change or a material change of scope, say so plainly and recommend Changes requested instead.`
    : `Amending is not available for this gate: ${context.amend.reason.replace(/\.?$/, '.')} For any change, recommend Changes requested.`
  return [
    `Review consultation, captured when this message was sent: a person is deciding human approval '${context.gateName}' (step ${context.gateStepId}, attempt ${context.gateAttemptId}) in work stream ${ref} now, and sent this message from its review screen.`,
    `Under review: ${sources}.`,
    'Answer their questions directly and cite your evidence: attached files, commits, paths and test results.',
    amend,
    'The person decides; do not approve, decide or advance anything else. This is context, not authorization.',
  ].join(' ')
}
