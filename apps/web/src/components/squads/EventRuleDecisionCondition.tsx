import {
  DECISION_YESNO_DEFAULT_THRESHOLD,
  eventDecisionDefaultFields,
  type DecisionQuestion,
  type EventDecisionPredicate,
  type SquadEventRule,
} from '@ficus/shared'
import { SegmentedControl } from '../SegmentedControl'
import { SelectionPopup } from '../ThemedPopup'

const QUESTION_TYPES = [
  { value: 'yesno', label: 'Yes or no' },
  { value: 'choice', label: 'Choice' },
] as const
const ON_UNAVAILABLE = [
  { value: 'no-match', label: 'Don’t match' },
  { value: 'match', label: 'Match' },
] as const

const COMPARISONS = [
  { value: 'at-least', label: 'At least' },
  { value: 'at-most', label: 'At most' },
] as const

const numberOrUndefined = (text: string) => (text.trim() === '' ? undefined : Number(text))
/** An empty field stays empty (and invalid) while typing rather than snapping to a number. */
const numberOrNaN = (text: string) => (text.trim() === '' ? Number.NaN : Number(text))

/** A decision-model condition in an event rule: the question, the answer that matches, and what no answer means. */
export function EventRuleDecisionCondition({
  rule,
  predicate,
  label,
  onChange,
  onRemove,
}: {
  rule: SquadEventRule
  predicate: EventDecisionPredicate
  label: string
  onChange: (predicate: EventDecisionPredicate) => void
  onRemove: () => void
}) {
  const { question } = predicate
  const setQuestionType = (type: 'yesno' | 'choice') => {
    if (type === question.type) return
    if (type === 'yesno')
      onChange({
        ...predicate,
        question: { type: 'yesno', instructions: question.instructions },
        when: { type: 'yesno', op: 'at-least', probability: DECISION_YESNO_DEFAULT_THRESHOLD },
      })
    else
      onChange({
        ...predicate,
        question: { type: 'choice', instructions: question.instructions, options: { option_1: '', option_2: '' } },
        when: { type: 'choice', equals: 'option_1' },
      })
  }
  const yesno =
    predicate.when?.type === 'yesno'
      ? predicate.when
      : { type: 'yesno' as const, op: 'at-least' as const, probability: DECISION_YESNO_DEFAULT_THRESHOLD }
  const sent = ['subject', ...(predicate.input?.fields ?? eventDecisionDefaultFields(rule.source))]
  return (
    <div role="group" aria-label={label} className="w-full space-y-2 rounded-lg border border-panel-border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h6 className="text-xs font-medium text-primary">Decision condition</h6>
        <button
          type="button"
          aria-label={`Remove ${label.toLowerCase()}`}
          className="ficus-button ficus-button-danger px-2 py-1 text-xs"
          onClick={onRemove}
        >
          Remove condition
        </button>
      </div>
      {question.type === 'score' ? (
        <p className="text-xs text-muted">
          A score question ({question.levels.map((level) => level.label).join(', ')}). Edit it through the API or CLI.
        </p>
      ) : (
        <SegmentedControl
          ariaLabel={`${label} question type`}
          options={QUESTION_TYPES}
          value={question.type}
          onChange={setQuestionType}
        />
      )}
      <label className="block text-xs">
        Question
        <textarea
          aria-label={`${label} question`}
          className="ficus-field mt-1 block w-full"
          rows={2}
          maxLength={4000}
          value={question.instructions}
          placeholder={question.type === 'yesno' ? 'The issue reports a bug.' : 'What kind of request is this?'}
          onChange={(event) => onChange({ ...predicate, question: { ...question, instructions: event.target.value } })}
        />
      </label>
      {question.type === 'yesno' && (
        <div className="space-y-1 text-xs">
          <p>Match when the chance of yes is</p>
          <div className="flex flex-wrap items-center gap-2">
            <SegmentedControl
              ariaLabel={`${label} comparison`}
              size="compact"
              options={COMPARISONS}
              value={yesno.op}
              onChange={(op) => onChange({ ...predicate, when: { ...yesno, op } })}
            />
            <input
              aria-label={`${label} threshold`}
              className="ficus-field block w-32"
              type="number"
              min={0}
              max={1}
              step={0.05}
              value={Number.isNaN(yesno.probability) ? '' : yesno.probability}
              placeholder="0.5"
              onChange={(event) =>
                onChange({ ...predicate, when: { ...yesno, probability: numberOrNaN(event.target.value) } })
              }
            />
          </div>
        </div>
      )}
      {question.type === 'choice' && (
        <ChoiceEditor
          label={label}
          predicate={predicate}
          question={question}
          onChange={(nextQuestion, when) =>
            onChange({ ...predicate, question: nextQuestion, when: when ?? predicate.when })
          }
        />
      )}
      <div className="text-xs">
        <p>When no decision model answers</p>
        <SegmentedControl
          ariaLabel={`${label} when no decision model answers`}
          options={ON_UNAVAILABLE}
          value={predicate.onUnavailable}
          onChange={(onUnavailable) => onChange({ ...predicate, onUnavailable })}
          className="mt-1"
        />
      </div>
      <p className="text-xs text-muted">
        Asked only after every other check of this rule passes, once per event, using the decision models set for event
        rule conditions. Sends the event’s {sent.join(', ')}
        {predicate.input?.body === false ? '' : ' and text'} as data, never as part of the question.
      </p>
    </div>
  )
}

function ChoiceEditor({
  label,
  predicate,
  question,
  onChange,
}: {
  label: string
  predicate: EventDecisionPredicate
  question: Extract<DecisionQuestion, { type: 'choice' }>
  onChange: (question: DecisionQuestion, when?: EventDecisionPredicate['when']) => void
}) {
  const options = Object.entries(question.options)
  const when = predicate.when?.type === 'choice' ? predicate.when : undefined
  const expected = when?.equals
  const rename = (index: number, name: string) => {
    // Two options cannot share a name; keep the edit out rather than silently dropping one.
    if (options.some(([other], i) => i !== index && other === name)) return
    const previous = options[index]![0]
    const next = Object.fromEntries(options.map(([key, value], i) => [i === index ? name : key, value]))
    onChange({ ...question, options: next }, when && expected === previous ? { ...when, equals: name } : undefined)
  }
  const describe = (index: number, description: string) =>
    onChange({
      ...question,
      options: Object.fromEntries(options.map(([key, value], i) => [key, i === index ? description : value])),
    })
  const remove = (index: number) => {
    const removed = options[index]![0]
    const next = Object.fromEntries(options.filter((_, i) => i !== index))
    onChange(
      { ...question, options: next },
      expected === removed && when ? { ...when, equals: Object.keys(next)[0]! } : undefined
    )
  }
  const add = () => {
    let n = options.length + 1
    while (Object.hasOwn(question.options, `option_${n}`)) n++
    onChange({ ...question, options: { ...question.options, [`option_${n}`]: '' } })
  }
  return (
    <div className="space-y-2">
      <p className="text-xs">Options (lowercase names; the description tells the model what each means)</p>
      {options.map(([name, description], index) => (
        <div key={index} className="flex flex-wrap items-center gap-2">
          <input
            aria-label={`${label} option ${index + 1} name`}
            className="ficus-field w-36 font-mono text-xs"
            value={name}
            maxLength={64}
            onChange={(event) => rename(index, event.target.value)}
          />
          <input
            aria-label={`${label} option ${index + 1} description`}
            className="ficus-field min-w-0 flex-1 text-xs"
            value={description}
            maxLength={1000}
            placeholder="What this option means"
            onChange={(event) => describe(index, event.target.value)}
          />
          <button
            type="button"
            aria-label={`Remove ${label.toLowerCase()} option ${index + 1}`}
            className="ficus-button ficus-button-secondary px-2 py-1 text-xs disabled:opacity-40"
            disabled={options.length <= 2}
            onClick={() => remove(index)}
          >
            Remove
          </button>
        </div>
      ))}
      <button
        type="button"
        className="ficus-button ficus-button-secondary px-2 py-1 text-xs disabled:opacity-40"
        disabled={options.length >= 64}
        onClick={add}
      >
        Add option
      </button>
      <div className="flex flex-wrap items-end gap-3 text-xs">
        <div>
          <p>Match when the answer is</p>
          <SelectionPopup
            label={`${label} expected choice`}
            className="ficus-field mt-1 block min-w-36 text-left font-mono text-xs"
            value={expected ?? ''}
            options={options.map(([name, description]) => ({
              value: name,
              label: name || '(unnamed)',
              ...(description ? { description } : {}),
            }))}
            onChange={(equals) => onChange(question, { type: 'choice', equals, minConfidence: when?.minConfidence })}
          >
            {expected || 'Choose an option'}
          </SelectionPopup>
        </div>
        <label>
          With confidence at least (optional)
          <input
            aria-label={`${label} minimum confidence`}
            className="ficus-field mt-1 block w-32"
            type="number"
            min={0}
            max={1}
            step={0.05}
            value={when?.minConfidence ?? ''}
            onChange={(event) =>
              onChange(question, {
                type: 'choice',
                equals: when?.equals ?? options[0]![0],
                minConfidence: numberOrUndefined(event.target.value),
              })
            }
          />
        </label>
      </div>
    </div>
  )
}
