import { z } from 'zod'

export const WORKFLOW_DECISION_BRIEF_LIMITS = {
  decision: 500,
  recommendation: 1000,
  approvalEffect: 2400,
  risks: 1600,
  changesSinceLastReview: 2000,
} as const

/** Mask literal data, never change the submitted text. This linter is deliberately field-local. */
function authoredProse(text: string): string {
  return text.replace(
    /```[\s\S]*?```|`[^`\n]*`|\]\([^)]*\)|https?:\/\/[^\s]+|(?<![\w])(?:\.{0,2}\/|~\/|[A-Za-z]:\\)[\w./\\-]+|\b[\da-f]{8}-[\da-f-]{27,}\b|\b[\da-f]{40,64}\b|"[^"\n]*"|“[^”]*”|‘[^’]*’|(?<![\p{L}])'[^'\n]+'(?![\p{L}])/giu,
    ' '
  )
}

/** Conservative compression checks, not a grammar or factual-accuracy judge. */
export function decisionBriefProseError(
  field: keyof typeof WORKFLOW_DECISION_BRIEF_LIMITS,
  text: string
): string | null {
  const prose = authoredProse(text).replace(
    /\b(?:[A-Za-z]\.){2,}|\b(?:Dr|Mr|Mrs|Ms|Prof|Sr|Jr|vs|etc)\./g,
    'abbreviation'
  )
  const words = [...new Intl.Segmenter(undefined, { granularity: 'word' }).segment(prose)].filter((s) => s.isWordLike)
  const compressed =
    /[.!?][A-Za-z]|[a-zA-Z]{33,}|\b(?:pls|plz|thx|apprv|reqd|rdy|b4)\b|\bw\/(?:o\b)?|\bb\/c\b/i.test(prose) ||
    (prose.match(/\b[a-z][a-zA-Z]+\b/g) ?? []).some((word) => (word.match(/[a-z][A-Z]/g)?.length ?? 0) >= 3)
  if (
    [...text].some((c) => {
      const n = c.charCodeAt(0)
      return (n < 32 && ![9, 10, 13].includes(n)) || [127, 0x200b, 0x2060, 0xfeff].includes(n)
    }) ||
    compressed ||
    words.length < (field === 'decision' ? 3 : 2)
  )
    return `decisionBrief.${field} must be readable prose with normal spacing and complete words.`
  if (
    field === 'decision' &&
    (/^\s*(?:#{1,6}\s|[-*+]\s|\d+[.)]\s)|```/m.test(text) ||
      [...new Intl.Segmenter(undefined, { granularity: 'sentence' }).segment(prose)].filter((s) => s.segment.trim())
        .length > 2)
  )
    return 'decisionBrief.decision must state the decision in one or two plain sentences.'
  return null
}
function field(name: keyof typeof WORKFLOW_DECISION_BRIEF_LIMITS) {
  const message = `decisionBrief.${name} must contain 1–${WORKFLOW_DECISION_BRIEF_LIMITS[name]} characters.`
  return z
    .string()
    .trim()
    .min(1, message)
    .max(WORKFLOW_DECISION_BRIEF_LIMITS[name], message)
    .superRefine((value, ctx) => {
      const error = decisionBriefProseError(name, value)
      if (error) ctx.addIssue({ code: 'custom', message: error })
    })
}
export const workflowDecisionBriefSchema = z.strictObject({
  decision: field('decision'),
  recommendation: field('recommendation'),
  approvalEffect: field('approvalEffect'),
  risks: field('risks'),
  changesSinceLastReview: field('changesSinceLastReview').optional(),
})
export type WorkflowDecisionBrief = z.infer<typeof workflowDecisionBriefSchema>
