import clsx from 'clsx'
import type { ReactNode } from 'react'
import {
  DECISION_NAME_PATTERN,
  WORKFLOW_DECISION_INPUTS,
  WORKFLOW_DECISION_INPUT_INFO,
  decisionConditionQuestion,
  workflowDecisionStepIssues,
  type DecisionCondition,
  type DecisionQuestion,
  type WorkflowDecisionRoute,
  type WorkflowDecisionStep,
} from '@ficus/shared'
import { SegmentedControl, type SegmentedControlOption } from '../SegmentedControl'
import { SelectionPopup, type PopupOption } from '../ThemedPopup'
import { ChevronDownIcon } from '../icons'

const field = 'ficus-field w-full min-w-0 rounded-md border border-th-border bg-surface px-3 py-2 text-sm'
const picker =
  'ficus-button ficus-button-secondary flex min-w-0 items-center justify-between gap-2 rounded-md px-2 py-1.5 text-sm'
const link = 'ficus-button ficus-button-link text-sm disabled:opacity-40'
/** The value the fallback pickers use for "no outcome": wait for a person to choose. */
const PERSON = '$person'

type QuestionType = DecisionQuestion['type']
const questionTypes: SegmentedControlOption<QuestionType>[] = [
  { value: 'yesno', label: 'Yes / no' },
  { value: 'choice', label: 'Choice' },
  { value: 'score', label: 'Score' },
]
const comparisons: PopupOption<'at-least' | 'at-most'>[] = [
  { value: 'at-least', label: 'at least' },
  { value: 'at-most', label: 'at most' },
]

function Help({ children }: { children: ReactNode }) {
  return <span className="mb-1 block text-xs font-normal text-muted">{children}</span>
}

function Picker<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled,
}: {
  label: string
  value: T
  options: readonly PopupOption<T>[]
  onChange: (value: T) => void
  disabled?: boolean
}) {
  return (
    <SelectionPopup
      label={label}
      value={value}
      options={options}
      onChange={onChange}
      disabled={disabled}
      className={picker}
    >
      <span className="truncate">{options.find((option) => option.value === value)?.label ?? value}</span>
      <ChevronDownIcon className="h-3 w-3 shrink-0 text-muted" />
    </SelectionPopup>
  )
}

function newQuestion(type: QuestionType, instructions: string): DecisionQuestion {
  if (type === 'choice') return { type, instructions, options: { first: '', second: '' } }
  if (type === 'score')
    return { type, instructions, levels: [{ label: 'Low' }, { label: 'Medium' }, { label: 'High' }] }
  return { type, instructions }
}

/** The default condition on a question, used when a route picks it or its type changes. */
function defaultDecisionCondition(name: string, question: DecisionQuestion): DecisionCondition {
  if (question.type === 'choice')
    return { type: 'choice', question: name, equals: Object.keys(question.options)[0] ?? 'first' }
  if (question.type === 'score')
    return { type: 'score', question: name, op: 'at-least', level: question.levels.at(-1)?.label ?? 'High' }
  return { type: 'yesno', question: name, op: 'at-least', probability: 0.8 }
}

const percent = (value: number | undefined) => (value === undefined ? '' : String(Math.round(value * 100)))
const fromPercent = (text: string) => Math.min(100, Math.max(0, Number(text) || 0)) / 100

function uniqueName(taken: Record<string, unknown>, base: string) {
  let name = base
  for (let index = 2; Object.hasOwn(taken, name); index++) name = `${base}_${index}`
  return name
}

/** Edit what a decision step asks its decision model and where each answer sends the work. */
export function WorkflowDecisionEditor({
  step,
  onChange,
  disabled,
}: {
  step: WorkflowDecisionStep
  onChange: (step: WorkflowDecisionStep) => void
  disabled?: boolean
}) {
  const edit = (change: (draft: WorkflowDecisionStep) => void) => {
    const draft = structuredClone(step)
    // A condition may omit its question when the step asks only one; the editor always names it.
    for (const route of draft.routes)
      if (route.when.question === undefined)
        route.when.question = decisionConditionQuestion(route.when, draft.questions)
    change(draft)
    onChange(draft)
  }
  const outcomes = Object.keys(step.outcomes)
  const outcomeOptions: PopupOption<string>[] = outcomes.map((name) => ({ value: name, label: name }))
  const fallbackOptions: PopupOption<string>[] = [
    { value: PERSON, label: 'Ask a person', description: 'Wait for a reviewer to choose, like an approval.' },
    ...outcomeOptions,
  ]
  const questionOptions: PopupOption<string>[] = Object.keys(step.questions).map((name) => ({
    value: name,
    label: name,
  }))
  const issues = workflowDecisionStepIssues(step)

  const renameQuestion = (previous: string, next: string) =>
    edit((draft) => {
      draft.questions = Object.fromEntries(
        Object.entries(draft.questions).map(([name, question]) => [name === previous ? next : name, question])
      )
      for (const route of draft.routes) if (route.when.question === previous) route.when.question = next
    })
  const setQuestion = (name: string, question: DecisionQuestion) =>
    edit((draft) => {
      const previous = draft.questions[name]
      draft.questions[name] = question
      // A new type invalidates the old conditions on this question; restart them from a default.
      if (previous?.type !== question.type)
        for (const route of draft.routes)
          if (route.when.question === name) route.when = defaultDecisionCondition(name, question)
    })
  const setRoute = (index: number, change: (route: WorkflowDecisionRoute) => void) =>
    edit((draft) => change(draft.routes[index]!))

  return (
    <div className="space-y-5" aria-label="Decision">
      <p className="text-xs text-muted">
        No agent works on this step. Ficus asks a decision model these questions and follows the first route that
        matches.
      </p>

      <fieldset className="space-y-2 text-sm" disabled={disabled}>
        <legend className="text-sm">Looks at</legend>
        <Help>What the decision model sees. It is treated as data, never as instructions.</Help>
        {WORKFLOW_DECISION_INPUTS.map((source) => (
          <label key={source} className="flex items-start gap-2">
            <input
              type="checkbox"
              className="mt-1"
              checked={step.input.includes(source)}
              disabled={step.input.length === 1 && step.input.includes(source)}
              onChange={(event) =>
                edit((draft) => {
                  draft.input = event.target.checked
                    ? WORKFLOW_DECISION_INPUTS.filter((entry) => entry === source || draft.input.includes(entry))
                    : draft.input.filter((entry) => entry !== source)
                })
              }
            />
            <span>
              {WORKFLOW_DECISION_INPUT_INFO[source].label}
              <span className="block text-xs text-muted">{WORKFLOW_DECISION_INPUT_INFO[source].description}</span>
            </span>
          </label>
        ))}
      </fieldset>

      <section className="space-y-3" aria-label="Questions">
        <div>
          <h5 className="text-sm">Questions</h5>
          <Help>Each answer is a probability, an option or a level, never free text.</Help>
        </div>
        {Object.entries(step.questions).map(([name, question]) => (
          <div key={name} className="space-y-2 rounded-md border border-th-border p-3">
            <div className="flex items-end gap-2">
              <label className="block min-w-0 flex-1 text-xs text-secondary">
                Name
                <input
                  className={field}
                  defaultValue={name}
                  disabled={disabled}
                  aria-label={`Question ${name} name`}
                  onBlur={(event) => {
                    const next = event.target.value.trim()
                    if (next === name) return
                    if (!DECISION_NAME_PATTERN.test(next) || Object.hasOwn(step.questions, next)) {
                      event.target.value = name
                      return
                    }
                    renameQuestion(name, next)
                  }}
                />
              </label>
              <button
                type="button"
                className="ficus-button ficus-button-danger rounded-md px-2 py-1.5 text-xs disabled:opacity-40"
                disabled={disabled || Object.keys(step.questions).length === 1}
                onClick={() =>
                  edit((draft) => {
                    delete draft.questions[name]
                    draft.routes = draft.routes.filter((route) => route.when.question !== name)
                  })
                }
              >
                Remove
              </button>
            </div>
            <SegmentedControl
              ariaLabel={`Question ${name} type`}
              options={questionTypes}
              value={question.type}
              disabled={disabled}
              onChange={(type) => setQuestion(name, newQuestion(type, question.instructions))}
            />
            <label className="block text-xs text-secondary">
              {question.type === 'yesno' ? 'Statement' : 'Question'}
              <textarea
                className={field}
                rows={2}
                disabled={disabled}
                aria-label={`Question ${name} instructions`}
                placeholder={
                  question.type === 'yesno' ? 'The change is complete and verified.' : 'What kind of change is this?'
                }
                value={question.instructions}
                onChange={(event) => setQuestion(name, { ...question, instructions: event.target.value })}
              />
            </label>
            {question.type === 'choice' && (
              <div className="space-y-2">
                <p className="text-xs text-secondary">Options</p>
                {Object.entries(question.options).map(([option, description]) => (
                  <div key={option} className="flex gap-2">
                    <input
                      className={clsx(field, 'w-32 flex-none')}
                      defaultValue={option}
                      disabled={disabled}
                      aria-label={`Option ${option} name`}
                      onBlur={(event) => {
                        const next = event.target.value.trim()
                        if (next === option) return
                        if (!DECISION_NAME_PATTERN.test(next) || Object.hasOwn(question.options, next)) {
                          event.target.value = option
                          return
                        }
                        edit((draft) => {
                          const target = draft.questions[name]
                          if (target?.type !== 'choice') return
                          target.options = Object.fromEntries(
                            Object.entries(target.options).map(([key, value]) => [key === option ? next : key, value])
                          )
                          for (const route of draft.routes)
                            if (
                              route.when.type === 'choice' &&
                              route.when.question === name &&
                              route.when.equals === option
                            )
                              route.when.equals = next
                        })
                      }}
                    />
                    <input
                      className={field}
                      disabled={disabled}
                      aria-label={`Option ${option} description`}
                      placeholder="What this option means"
                      value={description}
                      onChange={(event) =>
                        setQuestion(name, {
                          ...question,
                          options: { ...question.options, [option]: event.target.value },
                        })
                      }
                    />
                    <button
                      type="button"
                      className="ficus-button ficus-button-ghost rounded-md px-2 text-xs disabled:opacity-40"
                      aria-label={`Remove option ${option}`}
                      disabled={disabled || Object.keys(question.options).length <= 2}
                      onClick={() =>
                        setQuestion(name, {
                          ...question,
                          options: Object.fromEntries(
                            Object.entries(question.options).filter(([key]) => key !== option)
                          ),
                        })
                      }
                    >
                      ×
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  className={link}
                  disabled={disabled || Object.keys(question.options).length >= 64}
                  onClick={() =>
                    setQuestion(name, {
                      ...question,
                      options: { ...question.options, [uniqueName(question.options, 'option')]: '' },
                    })
                  }
                >
                  Add option
                </button>
              </div>
            )}
            {question.type === 'score' && (
              <div className="space-y-2">
                <p className="text-xs text-secondary">Levels, lowest first</p>
                {question.levels.map((level, index) => (
                  <div key={index} className="flex gap-2">
                    <input
                      className={field}
                      disabled={disabled}
                      aria-label={`Level ${index + 1}`}
                      value={level.label}
                      onChange={(event) =>
                        edit((draft) => {
                          const target = draft.questions[name]
                          if (target?.type !== 'score') return
                          for (const route of draft.routes)
                            if (
                              route.when.type === 'score' &&
                              route.when.question === name &&
                              route.when.level === level.label
                            )
                              route.when.level = event.target.value
                          target.levels[index] = { ...level, label: event.target.value }
                        })
                      }
                    />
                    <button
                      type="button"
                      className="ficus-button ficus-button-ghost rounded-md px-2 text-xs disabled:opacity-40"
                      aria-label={`Remove level ${index + 1}`}
                      disabled={disabled || question.levels.length <= 2}
                      onClick={() =>
                        setQuestion(name, {
                          ...question,
                          levels: question.levels.filter((_, entry) => entry !== index),
                        })
                      }
                    >
                      ×
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  className={link}
                  disabled={disabled || question.levels.length >= 10}
                  onClick={() =>
                    setQuestion(name, {
                      ...question,
                      levels: [...question.levels, { label: `Level ${question.levels.length + 1}` }],
                    })
                  }
                >
                  Add level
                </button>
              </div>
            )}
          </div>
        ))}
        <button
          type="button"
          className={link}
          disabled={disabled || Object.keys(step.questions).length >= 64}
          onClick={() =>
            edit((draft) => {
              draft.questions[uniqueName(draft.questions, 'question')] = newQuestion('yesno', '')
            })
          }
        >
          Add question
        </button>
      </section>

      <section className="space-y-3" aria-label="Routes">
        <div>
          <h5 className="text-sm">Routes</h5>
          <Help>Checked in order; the first that matches chooses the outcome.</Help>
        </div>
        {step.routes.map((route, index) => {
          const condition = route.when
          const name = decisionConditionQuestion(condition, step.questions)
          const question = name === undefined ? undefined : step.questions[name]
          return (
            <div
              key={index}
              className="space-y-2 rounded-md border border-th-border p-3"
              aria-label={`Route ${index + 1}`}
            >
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="text-muted">{index + 1}. If</span>
                <Picker
                  label={`Route ${index + 1} question`}
                  value={name ?? ''}
                  options={questionOptions}
                  disabled={disabled}
                  onChange={(next) =>
                    setRoute(index, (draft) => {
                      draft.when = defaultDecisionCondition(next, step.questions[next]!)
                    })
                  }
                />
                {condition.type === 'yesno' && (
                  <>
                    <span className="text-muted">is true with</span>
                    <Picker
                      label={`Route ${index + 1} comparison`}
                      value={condition.op}
                      options={comparisons}
                      disabled={disabled}
                      onChange={(op) =>
                        setRoute(index, (draft) => {
                          if (draft.when.type === 'yesno') draft.when.op = op
                        })
                      }
                    />
                    <input
                      type="number"
                      min={0}
                      max={100}
                      className={clsx(field, 'w-20 flex-none')}
                      disabled={disabled}
                      aria-label={`Route ${index + 1} probability percent`}
                      value={percent(condition.probability)}
                      onChange={(event) =>
                        setRoute(index, (draft) => {
                          if (draft.when.type === 'yesno') draft.when.probability = fromPercent(event.target.value)
                        })
                      }
                    />
                    <span className="text-muted">%</span>
                  </>
                )}
                {condition.type === 'choice' && question?.type === 'choice' && (
                  <>
                    <span className="text-muted">is</span>
                    <Picker
                      label={`Route ${index + 1} option`}
                      value={condition.equals}
                      options={Object.keys(question.options).map((option) => ({ value: option, label: option }))}
                      disabled={disabled}
                      onChange={(equals) =>
                        setRoute(index, (draft) => {
                          if (draft.when.type === 'choice') draft.when.equals = equals
                        })
                      }
                    />
                    <span className="text-muted">with at least</span>
                    <input
                      type="number"
                      min={0}
                      max={100}
                      className={clsx(field, 'w-20 flex-none')}
                      disabled={disabled}
                      placeholder="any"
                      aria-label={`Route ${index + 1} minimum confidence percent`}
                      value={percent(condition.minConfidence)}
                      onChange={(event) =>
                        setRoute(index, (draft) => {
                          if (draft.when.type !== 'choice') return
                          if (event.target.value === '') delete draft.when.minConfidence
                          else draft.when.minConfidence = fromPercent(event.target.value)
                        })
                      }
                    />
                    <span className="text-muted">%</span>
                  </>
                )}
                {condition.type === 'score' && question?.type === 'score' && (
                  <>
                    <span className="text-muted">is</span>
                    <Picker
                      label={`Route ${index + 1} comparison`}
                      value={condition.op}
                      options={comparisons}
                      disabled={disabled}
                      onChange={(op) =>
                        setRoute(index, (draft) => {
                          if (draft.when.type === 'score') draft.when.op = op
                        })
                      }
                    />
                    <Picker
                      label={`Route ${index + 1} level`}
                      value={condition.level}
                      options={question.levels.map((level) => ({ value: level.label, label: level.label }))}
                      disabled={disabled}
                      onChange={(level) =>
                        setRoute(index, (draft) => {
                          if (draft.when.type === 'score') draft.when.level = level
                        })
                      }
                    />
                  </>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="text-muted">then</span>
                <Picker
                  label={`Route ${index + 1} outcome`}
                  value={route.outcome}
                  options={outcomeOptions}
                  disabled={disabled}
                  onChange={(outcome) =>
                    setRoute(index, (draft) => {
                      draft.outcome = outcome
                    })
                  }
                />
                <span className="ml-auto flex gap-3">
                  <button
                    type="button"
                    className={link}
                    aria-label={`Move route ${index + 1} up`}
                    disabled={disabled || index === 0}
                    onClick={() =>
                      edit((draft) => {
                        ;[draft.routes[index - 1], draft.routes[index]] = [
                          draft.routes[index]!,
                          draft.routes[index - 1]!,
                        ]
                      })
                    }
                  >
                    Up
                  </button>
                  <button
                    type="button"
                    className={link}
                    aria-label={`Move route ${index + 1} down`}
                    disabled={disabled || index === step.routes.length - 1}
                    onClick={() =>
                      edit((draft) => {
                        ;[draft.routes[index], draft.routes[index + 1]] = [
                          draft.routes[index + 1]!,
                          draft.routes[index]!,
                        ]
                      })
                    }
                  >
                    Down
                  </button>
                  <button
                    type="button"
                    className={link}
                    aria-label={`Remove route ${index + 1}`}
                    disabled={disabled}
                    onClick={() => edit((draft) => void draft.routes.splice(index, 1))}
                  >
                    Remove
                  </button>
                </span>
              </div>
            </div>
          )
        })}
        <button
          type="button"
          className={link}
          disabled={disabled || step.routes.length >= 32 || !outcomes.length}
          onClick={() =>
            edit((draft) => {
              const [name, question] = Object.entries(draft.questions)[0]!
              draft.routes.push({ when: defaultDecisionCondition(name, question), outcome: outcomes[0]! })
            })
          }
        >
          Add route
        </button>
      </section>

      <div className="grid gap-3 text-sm">
        <div className="space-y-1">
          <span className="block text-xs text-secondary">Otherwise</span>
          <Help>When no route matches.</Help>
          <Picker
            label="Otherwise"
            value={step.otherwise ?? PERSON}
            options={fallbackOptions}
            disabled={disabled}
            onChange={(value) =>
              edit((draft) => {
                if (value === PERSON) delete draft.otherwise
                else draft.otherwise = value
              })
            }
          />
        </div>
        <div className="space-y-1">
          <span className="block text-xs text-secondary">If there is no answer</span>
          <Help>No decision provider is set up or answers in time, or the model refuses a question.</Help>
          <Picker
            label="If there is no answer"
            value={step.unavailable ?? PERSON}
            options={fallbackOptions}
            disabled={disabled}
            onChange={(value) =>
              edit((draft) => {
                if (value === PERSON) delete draft.unavailable
                else draft.unavailable = value
              })
            }
          />
        </div>
      </div>

      {issues.length > 0 && (
        <ul role="alert" className="space-y-1 text-xs text-status-danger-600 dark:text-status-danger-400">
          {issues.map((issue) => (
            <li key={issue.path.join('.')}>{issue.message}</li>
          ))}
        </ul>
      )}
    </div>
  )
}
