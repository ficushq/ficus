import { createHash } from 'node:crypto'
import type { DecisionAnswer, DecisionPurpose, DecisionQuestions, DecisionRequest } from '@ficus/shared'

/*
 * Decision evals: labelled cases for one decision-powered feature, run live against decision
 * providers (`bun run decisions:eval`), recorded, and replayed offline in CI. An eval builds each
 * request and reads each answer with the feature's own production code, so it tests what ships.
 * See AGENTS.md → "Decision features need evals".
 */

/** What one case expects: the outcome itself, or for an object outcome, the fields that must match. */
export type Expectation<Outcome> = Outcome extends object ? Partial<Outcome> : Outcome

export interface EvalCaseLabels<Outcome> {
  /** Unique within the eval; defaults to `caseName(case)`. Snapshots and diffs are keyed by it. */
  name?: string
  /** The one right outcome. */
  expect?: Expectation<Outcome>
  /** Any of these is right (e.g. Interrupt or "no suggestion" for an acknowledgement). */
  accept?: Expectation<Outcome>[]
  /** A regression here fails the run whatever the overall accuracy. */
  must?: boolean
  /** Why the label is what it is, when it isn't obvious. */
  note?: string
}

/** A case recorded from a real request (a saved correction), instead of built from fields. */
export interface RawEvalCase<Outcome> extends EvalCaseLabels<Outcome> {
  name: string
  request: DecisionRequest
  /** What the eval's `decide` needs besides the answers (e.g. routing's option keys). */
  context?: unknown
}

export type EvalCase<Input, Outcome> = (Input & EvalCaseLabels<Outcome>) | RawEvalCase<Outcome>

export interface BuiltRequest {
  request: DecisionRequest
  context?: unknown
}

export interface DecisionEval<Input = unknown, Outcome = unknown> {
  /** Unique across evals; the CLI selects evals by it. */
  name: string
  purpose: DecisionPurpose
  description?: string
  /** The production request for a case. */
  build: (input: Input) => BuiltRequest
  /** The production rule: the answers (and the build's context) to the feature's outcome. */
  decide: (answers: Record<string, DecisionAnswer>, context: unknown) => Outcome
  /** The thresholds the rule compares each yes/no answer with, for the margin column. */
  thresholds?: Record<string, number[]>
  cases: EvalCase<Input, Outcome>[]
  caseName?: (input: Input) => string
  /** Short text for an outcome in the table; JSON by default. */
  label?: (outcome: Outcome) => string
  /** The run fails when fewer cases than this (0 to 1) pass for a provider. */
  floor?: number
  /**
   * Prompt variants to compare with `--variant`: replacement questions, or a whole replacement build
   * (for questions made per request, like routing's squad options), and, if it changes, the rule.
   */
  variants?: Record<
    string,
    {
      questions?: DecisionQuestions
      build?: (input: Input) => BuiltRequest
      decide?: (answers: Record<string, DecisionAnswer>, context: unknown) => Outcome
    }
  >
}

export function defineDecisionEval<Input, Outcome>(evaluation: DecisionEval<Input, Outcome>) {
  return evaluation
}

export const isRawCase = <Input, Outcome>(c: EvalCase<Input, Outcome>): c is RawEvalCase<Outcome> =>
  typeof c === 'object' && c !== null && 'request' in c && typeof (c as { request: unknown }).request === 'object'

export function caseName<Input, Outcome>(
  evaluation: DecisionEval<Input, Outcome>,
  c: EvalCase<Input, Outcome>,
  index: number
) {
  if (c.name) return c.name
  if (!isRawCase(c) && evaluation.caseName) return evaluation.caseName(c as Input)
  return `case ${index + 1}`
}

/** The request for a case under a variant (its questions replace the case's). */
export function requestFor<Input, Outcome>(
  evaluation: DecisionEval<Input, Outcome>,
  c: EvalCase<Input, Outcome>,
  variant?: string
): BuiltRequest {
  const variantBuild = variant ? evaluation.variants?.[variant]?.build : undefined
  const built = isRawCase(c)
    ? { request: c.request, context: c.context }
    : (variantBuild ?? evaluation.build)(c as Input)
  const questions = variant ? evaluation.variants?.[variant]?.questions : undefined
  return questions ? { ...built, request: { ...built.request, questions } } : built
}

export function decideFor<Input, Outcome>(evaluation: DecisionEval<Input, Outcome>, variant?: string) {
  return (variant && evaluation.variants?.[variant]?.decide) || evaluation.decide
}

/** The request's identity: the same hash `decision_log.input_sha256` keeps. */
export function requestHash(request: DecisionRequest): string {
  return createHash('sha256').update(JSON.stringify(request)).digest('hex')
}

/** Whether an outcome meets an expectation: equal, or for objects, equal on every expected field. */
export function matches(outcome: unknown, expected: unknown): boolean {
  if (expected !== null && typeof expected === 'object' && outcome !== null && typeof outcome === 'object')
    return Object.entries(expected).every(([key, value]) => matches((outcome as Record<string, unknown>)[key], value))
  return Object.is(outcome, expected)
}

/** Whether a case's outcome is right; a case with no labels is only recorded. */
export function passes<Outcome>(labels: EvalCaseLabels<Outcome>, outcome: Outcome): boolean | null {
  const options = [...(labels.expect !== undefined ? [labels.expect] : []), ...(labels.accept ?? [])]
  if (!options.length) return null
  return options.some((option) => matches(outcome, option))
}

/**
 * How close the call was: how far the nearest answer could move before the outcome changes. For a
 * yes/no answer that is its distance to a threshold the rule uses (`thresholds`); for a choice, its
 * lead over the runner-up, and the distance of the pick's probability to any `thresholds` it has. With `decide`, only moves that would change the outcome count: an answer
 * next to a threshold that another answer already outweighs is not a close call. Null when no
 * single answer moving across a threshold would change it. Small margins pass by luck; watch them.
 */
export function margin(
  answers: Record<string, DecisionAnswer>,
  thresholds: Record<string, number[]> = {},
  decide?: (answers: Record<string, DecisionAnswer>) => unknown
): number | null {
  const outcome = decide ? JSON.stringify(decide(answers)) : null
  const changes = (name: string, answer: DecisionAnswer) =>
    !decide || JSON.stringify(decide({ ...answers, [name]: answer })) !== outcome
  let closest: number | null = null
  const consider = (value: number) => {
    if (Number.isFinite(value)) closest = closest === null ? value : Math.min(closest, value)
  }
  for (const [name, answer] of Object.entries(answers)) {
    if (answer.type === 'yesno') {
      for (const at of thresholds[name] ?? [0.5]) {
        // Just across the threshold from where the answer is.
        const across = answer.probability >= at ? at - 1e-6 : at
        if (changes(name, { ...answer, probability: across })) consider(Math.abs(answer.probability - at))
      }
    } else if (answer.type === 'choice' || answer.type === 'score') {
      // A rule that needs the pick to be sure enough (e.g. routing's 0.6): distance to that bar.
      const picked = answer.type === 'choice' ? answer.choice : answer.level
      const pickedP = answer.probabilities?.[picked] ?? 0
      for (const at of thresholds[name] ?? []) {
        const across = pickedP >= at ? at - 1e-6 : at
        if (changes(name, { ...answer, probabilities: { ...answer.probabilities, [picked]: across } }))
          consider(Math.abs(pickedP - at))
      }
      const ranked = Object.entries(answer.probabilities ?? {}).sort((a, b) => b[1] - a[1])
      const [[top, topP] = ['', 0], [second, secondP] = ['', 0]] = ranked
      if (!second) continue
      const swapped = { ...answer.probabilities, [top]: secondP, [second]: topP }
      const flipped =
        answer.type === 'choice'
          ? { ...answer, choice: second, probabilities: swapped }
          : { ...answer, level: second, probabilities: swapped }
      if (changes(name, flipped)) consider(topP - secondP)
    }
  }
  return closest
}

/** One answer for the table: a yes/no probability, or a choice and its probability. */
export function shortAnswer(answer: DecisionAnswer): string {
  switch (answer.type) {
    case 'yesno':
      return answer.probability.toFixed(2)
    case 'choice':
      return `${answer.choice} ${(answer.probabilities?.[answer.choice] ?? answer.confidence ?? 0).toFixed(2)}`
    case 'score':
      return `${answer.level} ${answer.score.toFixed(2)}`
    case 'refusal':
      return 'refused'
  }
}
