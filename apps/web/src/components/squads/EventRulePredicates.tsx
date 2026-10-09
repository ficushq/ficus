import {
  DECISION_YESNO_DEFAULT_THRESHOLD,
  EVENT_DECISION_PREDICATES_MAX,
  eventPredicateFields,
  eventPredicateOperators,
  isEventDecisionPredicate,
  squadEventRuleSchema,
  type EventDecisionPredicate,
  type EventPredicate,
  type EventRulePredicate,
  type SquadEventRule,
} from '@ficus/shared'
import { EventRuleDecisionCondition } from './EventRuleDecisionCondition'

const initialDecisionPredicate = (): EventDecisionPredicate => ({
  kind: 'decision',
  question: { type: 'yesno', instructions: '' },
  when: { type: 'yesno', op: 'at-least', probability: DECISION_YESNO_DEFAULT_THRESHOLD },
  onUnavailable: 'no-match',
})

export function EventRulePredicates({
  rule,
  position,
  onChange,
}: {
  rule: SquadEventRule
  position: number
  onChange: (predicates: EventRulePredicate[]) => void
}) {
  const fields = eventPredicateFields(rule.source) ?? {}
  const predicates = rule.predicates ?? []
  const decisionCount = predicates.filter(isEventDecisionPredicate).length
  const update = (index: number, predicate: EventRulePredicate) =>
    onChange(predicates.map((item, i) => (i === index ? predicate : item)))
  const validation = squadEventRuleSchema.safeParse(rule)
  const initial = (field: string): EventPredicate => ({
    field,
    op: fields[field]?.type === 'string[]' ? 'contains' : 'eq',
    value: fields[field]?.type === 'number' ? 0 : fields[field]?.type === 'boolean' ? true : '',
  })
  return (
    <div className="space-y-2">
      <h5 className="text-sm font-medium">Typed conditions</h5>
      <p className="text-xs text-muted">
        All conditions must match, AND the shared scope and other filters. Missing or null values fail comparisons
        (including neq); exists treats both as absent. Collection contains checks one exact member. Empty collections
        are present. A decision condition asks a decision model a question about the event; it is asked last, only when
        everything else matches.
      </p>
      {predicates.map((predicate, index) => {
        const prefix = `Rule ${position} condition ${index + 1}`
        if (isEventDecisionPredicate(predicate))
          return (
            <EventRuleDecisionCondition
              key={index}
              rule={rule}
              predicate={predicate}
              label={prefix}
              onChange={(next) => update(index, next)}
              onRemove={() => onChange(predicates.filter((_, i) => i !== index))}
            />
          )
        const field = fields[predicate.field]
        const boolean = predicate.op === 'exists' || (field?.type === 'boolean' && predicate.op !== 'in')
        return (
          <div key={index} className="flex flex-wrap items-end gap-2">
            <label className="text-xs">
              Field
              <select
                aria-label={`${prefix} field`}
                className="ficus-field block max-w-full"
                value={predicate.field}
                onChange={(event) => update(index, initial(event.target.value))}
              >
                {Object.entries(fields).map(([path, field]) => (
                  <option key={path} value={path}>
                    {path} ({field.type})
                  </option>
                ))}
              </select>
            </label>
            <label className="text-xs">
              Operator
              <select
                aria-label={`${prefix} operator`}
                className="ficus-field block"
                value={predicate.op}
                onChange={(event) => {
                  const op = event.target.value as EventPredicate['op']
                  update(index, {
                    ...predicate,
                    op,
                    value:
                      op === 'exists'
                        ? true
                        : op === 'in'
                          ? [initial(predicate.field).value as string | number | boolean]
                          : initial(predicate.field).value,
                  })
                }}
              >
                {(field ? eventPredicateOperators(field) : []).map((op) => (
                  <option key={op}>{op}</option>
                ))}
              </select>
            </label>
            <label className="min-w-0 flex-1 text-xs">
              {predicate.op === 'in' ? 'Values (JSON array)' : 'Value'}
              {boolean ? (
                <select
                  aria-label={`${prefix} value`}
                  className="ficus-field block w-full"
                  value={String(predicate.value)}
                  onChange={(event) => update(index, { ...predicate, value: event.target.value === 'true' })}
                >
                  <option value="true">true</option>
                  <option value="false">false</option>
                </select>
              ) : (
                <input
                  aria-label={`${prefix} value`}
                  className="ficus-field block w-full"
                  type={field?.type === 'number' && predicate.op !== 'in' ? 'number' : 'text'}
                  value={Array.isArray(predicate.value) ? JSON.stringify(predicate.value) : String(predicate.value)}
                  onChange={(event) => {
                    let value: EventPredicate['value'] = event.target.value
                    if (predicate.op === 'in') {
                      try {
                        value = JSON.parse(value)
                      } catch {
                        /* Keep invalid text visible; schema blocks saving. */
                      }
                    } else if (field?.type === 'number' && value !== '') value = Number(value)
                    update(index, { ...predicate, value })
                  }}
                />
              )}
            </label>
            <button
              type="button"
              aria-label={`Remove ${prefix.toLowerCase()}`}
              className="ficus-button ficus-button-danger px-2 py-1 text-xs"
              onClick={() => onChange(predicates.filter((_, i) => i !== index))}
            >
              Remove condition
            </button>
            {field && (
              <p className="w-full text-xs text-muted">
                {field.description}
                {field.normalize === 'lowercase' ? ' Compared case-insensitively.' : ''}
              </p>
            )}
          </div>
        )
      })}
      {!validation.success && (
        <p role="alert" className="text-xs text-status-danger-500">
          {validation.error.issues.map((issue) => issue.message).join('; ')}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className="ficus-button ficus-button-secondary px-3 py-1.5 text-sm disabled:opacity-40"
          disabled={!Object.keys(fields).length || predicates.length >= 16}
          onClick={() => onChange([...predicates, initial(Object.keys(fields)[0]!)])}
        >
          Add condition
        </button>
        <button
          type="button"
          className="ficus-button ficus-button-secondary px-3 py-1.5 text-sm disabled:opacity-40"
          disabled={
            !Object.keys(fields).length || predicates.length >= 16 || decisionCount >= EVENT_DECISION_PREDICATES_MAX
          }
          onClick={() => onChange([...predicates, initialDecisionPredicate()])}
        >
          Add decision condition
        </button>
      </div>
    </div>
  )
}
