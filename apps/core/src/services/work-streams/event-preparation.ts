/**
 * What the owner of an event-created work stream does before starting it. Shared by the
 * integration delivery notice and the owner notification, so both give the same steps.
 *
 * The title starts as the event type and resource (provider prose is deliberately kept out of
 * titles, which agents read as trusted text). The owner, who reads the event as evidence, gives
 * it a plain description and a short summary instead.
 */
export function eventStreamPreparationSteps(ref: string): string {
  return [
    `The workflow is paused before any workers start. Review the event and workflow, then:`,
    `1. Retitle it to say what the work is, in plain words a person can scan: \`ficus workstream update ${ref} --title "<title>"\` (for example "Review Dependabot bump: docker/login-action 3 → 4 (#824)").`,
    `2. Put a one- or two-sentence summary of the request at the top of the description, keeping the original event text unchanged below it: \`ficus workstream update ${ref} -d "<summary, then the original description>"\`.`,
    `3. Prepare its workspace if needed with \`ficus workstream update ${ref} --repository <checkout-path>\`, then start it with \`ficus workstream resume ${ref}\`. If no Git workspace is needed, resume after reviewing the task. Do not manually bypass repository setup guards.`,
  ].join('\n')
}
