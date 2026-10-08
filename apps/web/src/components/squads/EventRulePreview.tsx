import { useState } from 'react'
import {
  assumeEventRuleDecisions,
  eventPredicateFields,
  isEventDecisionPredicate,
  previewSquadEventRules,
  syntheticEventSampleSchema,
  syntheticEventFact,
  type IntegrationOutputDescriptor,
  type SquadEventRule,
  type SquadEventRulePreview,
} from '@ficus/shared'
import { SegmentedControl } from '../SegmentedControl'

const DECISION_ASSUMPTIONS = [
  { value: 'match', label: 'Match' },
  { value: 'no-match', label: 'Don’t match' },
] as const

export function EventRulePreview({
  provider,
  rules,
  metadata,
  events,
  accounts,
}: {
  provider: string
  rules: SquadEventRule[]
  metadata: unknown
  events: IntegrationOutputDescriptor[]
  accounts: Array<{ id: string; displayName: string }>
}) {
  const [eventKey, setEventKey] = useState('')
  const [fieldsText, setFieldsText] = useState('{}')
  const [login, setLogin] = useState('')
  const [connectionId, setConnectionId] = useState('')
  const [mentioned, setMentioned] = useState(false)
  const [decisionAssumption, setDecisionAssumption] = useState<'match' | 'no-match'>('match')
  const hasDecisions = rules.some((rule) => rule.predicates?.some(isEventDecisionPredicate))
  const event = events.find((item) => `${item.output}@${item.version}` === eventKey) ?? events[0]
  let preview: SquadEventRulePreview | undefined
  let error: string | undefined
  if (event) {
    let fields: unknown
    try {
      fields = JSON.parse(fieldsText)
    } catch {
      error = 'Enter a JSON object using the supported sample fields.'
    }
    if (!error) {
      const sample = syntheticEventSampleSchema.safeParse({
        source: {
          integration: provider,
          output: event.output,
          version: event.version,
          connectionId: connectionId || undefined,
        },
        fields,
        login,
        mentioned,
      })
      if (!sample.success)
        error = sample.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')
      else {
        try {
          preview = previewSquadEventRules(
            { ...((metadata as Record<string, unknown>) ?? {}), integrationRules: { [provider]: rules } },
            provider,
            syntheticEventFact(sample.data),
            login,
            connectionId || undefined,
            // No model is asked from the preview: decision conditions take the stated assumption.
            assumeEventRuleDecisions(decisionAssumption === 'match')
          )
        } catch {
          error = 'Fix invalid event rules before previewing.'
        }
      }
    }
  }
  return (
    <section className="space-y-3 border-t border-panel-border pt-4" aria-label="Match preview">
      <h4 className="font-medium text-primary">Match preview</h4>
      <p className="text-xs text-muted">
        Synthetic sample, evaluated locally against these unsaved rules and shared scope. This is rule selection, not a
        delivery guarantee: authorization, existing work-stream subscriptions, provider suppression and deduplication
        still govern dispatch. No events are fetched or delivered and nothing is saved.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-sm">
          Sample event
          <select
            aria-label="Sample event"
            className="ficus-field mt-1 block w-full"
            value={event ? `${event.output}@${event.version}` : ''}
            onChange={(e) => {
              setEventKey(e.target.value)
              setFieldsText('{}')
            }}
          >
            {events.map((event) => (
              <option key={`${event.output}@${event.version}`} value={`${event.output}@${event.version}`}>
                {event.title} (v{event.version})
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          Sample connection
          <select
            aria-label="Sample connection"
            className="ficus-field mt-1 block w-full"
            value={connectionId}
            onChange={(e) => setConnectionId(e.target.value)}
          >
            <option value="">Unspecified hypothetical connection</option>
            {accounts.map((account) => (
              <option key={account.id} value={account.id}>
                {account.displayName}
              </option>
            ))}
          </select>
        </label>
        {provider === 'github' && (
          <>
            <label className="text-sm">
              Hypothetical connected login
              <input
                aria-label="Sample connected login"
                className="ficus-field mt-1 block w-full"
                value={login}
                maxLength={100}
                onChange={(e) => setLogin(e.target.value)}
              />
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={mentioned} onChange={(e) => setMentioned(e.target.checked)} />
              Event text @mentions this login
            </label>
          </>
        )}
      </div>
      <label className="block text-sm">
        Sample fields (JSON)
        <textarea
          aria-label="Sample fields (JSON)"
          className="ficus-field mt-1 w-full font-mono text-xs"
          rows={4}
          maxLength={64000}
          value={fieldsText}
          onChange={(e) => setFieldsText(e.target.value)}
          placeholder={'{"repository":"owner/repo","issue.number":15,"labels":["bug"]}'}
        />
      </label>
      {hasDecisions && (
        <div className="text-sm">
          <p>Decision conditions</p>
          <SegmentedControl
            ariaLabel="Assume decision conditions"
            options={DECISION_ASSUMPTIONS}
            value={decisionAssumption}
            onChange={setDecisionAssumption}
            className="mt-1 max-w-xs"
          />
          <p className="mt-1 text-xs text-muted">
            The preview asks no decision model; it assumes every decision condition answers this way.
          </p>
        </div>
      )}
      <details className="text-xs text-muted">
        <summary>Supported fields and sample semantics</summary>
        <p>
          Use flat field names as JSON keys. Omit absent fields; null is absent for conditions. No body, credentials or
          raw payload. Empty strings and empty arrays are present. This sample assumes an authorized event on the chosen
          connection; the login is hypothetical, not fetched from that connection.
        </p>
        <ul>
          {event &&
            Object.entries(eventPredicateFields(event) ?? {}).map(([path, field]) => (
              <li key={path}>
                {path}: {field.type} — {field.description}
              </li>
            ))}
        </ul>
      </details>
      <div aria-live="polite" className="space-y-2 text-sm">
        {error && (
          <p role="alert" className="text-status-danger-500">
            {error}
          </p>
        )}
        {preview && (
          <>
            <p>
              {preview.suppression
                ? 'No matching action: comments/reviews authored by the connected account are suppressed.'
                : preview.selectedRuleId
                  ? `Selected: ${preview.selectedRuleId} → ${preview.action}`
                  : 'No matching rule: no squad action. Work-stream subscriptions are unaffected.'}
            </p>
            <ol className="space-y-2">
              {preview.rules.map((rule) => (
                <li key={rule.id}>
                  <p>
                    {rule.position}. {rule.id}: {rule.status}
                  </p>
                  {rule.status === 'shadowed' && (
                    <p className="text-xs text-muted">
                      Not evaluated because an earlier rule matched (including ignore).
                    </p>
                  )}
                  <ul className="text-xs text-muted">
                    {rule.checks.map((check, index) => (
                      <li key={index}>
                        {check.passed ? 'Pass' : 'Fail'}: {check.description}
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ol>
          </>
        )}
      </div>
    </section>
  )
}
