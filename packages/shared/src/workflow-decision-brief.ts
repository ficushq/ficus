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
    /```[\s\S]*?```|`[^`\n]*`|\]\([^)]*\)|https?:\/\/[^\s]+|(?<![\w])(?:\.{0,2}\/|~\/|[A-Za-z]:\\)[\w./\\-]+|(?<![\w])(?!(?:[Ww]\/[Oo]|[Bb]\/[Cc])\b)(?:[\w@.-]+\/)[\w./@+-]+|\b[\w.+-]+@[\w.-]+\b|\b[\w+-]+(?:\.[a-z0-9_][\w-]*)+\b|(?<![\w])\.[a-z][\w.-]*|\b[\da-fA-F]{8}-[\da-fA-F-]{27,}\b|\b[\da-fA-F]{40,64}\b|"[^"\n]*"|“[^”]*”|‘[^’]*’|(?<![\p{L}])'[^'\n]+'(?![\p{L}])/gu,
    (literal) => ` ${literal.match(/[.!?]+$/)?.[0] ?? ''} `
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
  const token =
    prose.match(/\b[A-Za-z]+[.!?][A-Z][a-z]+\b|[a-zA-Z]{33,}/)?.[0] ??
    prose.match(/\b(?:pls|plz|thx|apprv|reqd|rdy|b4)\b|\bw\/(?:o\b)?|\bb\/c\b/i)?.[0] ??
    (prose.match(/\b[a-z][a-zA-Z]+\b/g) ?? []).find((word) => (word.match(/[a-z][A-Z]/g)?.length ?? 0) >= 3)
  const control = [...text].find((c) => {
    const n = c.charCodeAt(0)
    return (n < 32 && ![9, 10, 13].includes(n)) || [127, 0x200b, 0x2060, 0xfeff].includes(n)
  })
  if (control || token || words.length < (field === 'decision' ? 3 : 2)) {
    const offender = control ? `U+${control.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}` : token
    return `decisionBrief.${field} must be readable prose with normal spacing and complete words.${offender ? ` Check token ${JSON.stringify(offender)}.` : ' Add an explanatory sentence, not only literal identifiers.'}`
  }
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
