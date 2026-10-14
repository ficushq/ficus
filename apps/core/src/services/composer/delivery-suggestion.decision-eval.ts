import type { DeliveryMode } from '@ficus/shared'
import { defineDecisionEval } from '../decisions/evals/define'
import {
  COMPOSER_DELIVERY_QUESTIONS,
  DELIVERY_FOLLOW_UP_NOW_AT_MOST,
  DELIVERY_FOLLOW_UP_RELATED_AT_MOST,
  DELIVERY_STEER_AT_LEAST,
  deliverySuggestionFrom,
  type ComposerDeliveryState,
} from './delivery-suggestion'

/** An agent partway through a task, as buildComposerDeliveryState would describe it. */
const BILLING_TASK: Omit<ComposerDeliveryState, 'draft'> = {
  asked: 'Add CSV export to the billing page: a Download CSV button that exports the filtered invoices.',
  workStream: 'Billing CSV export',
  recentTools: ['edit src/billing/export.ts', 'bash bun test src/billing', 'read src/billing/InvoiceTable.tsx'],
  lastSaid: 'The export endpoint works; now wiring the button into the invoice table and adding tests.',
}

/** Steer interrupts; follow-up queues; null suggests nothing and keeps the composer's mode (Interrupt by default). */
type Outcome = DeliveryMode | null

export default defineDecisionEval<{ draft: string }, Outcome>({
  name: 'composer-delivery',
  purpose: 'composer-delivery',
  description: 'Interrupt or Follow up for a draft written while an agent works.',
  build: ({ draft }) => ({ request: { state: { ...BILLING_TASK, draft }, questions: COMPOSER_DELIVERY_QUESTIONS } }),
  decide: (answers) => deliverySuggestionFrom(answers).suggestion,
  thresholds: {
    related: [DELIVERY_FOLLOW_UP_RELATED_AT_MOST, DELIVERY_STEER_AT_LEAST],
    now: [DELIVERY_FOLLOW_UP_NOW_AT_MOST, DELIVERY_STEER_AT_LEAST],
  },
  caseName: ({ draft }) => draft,
  label: (outcome) => outcome ?? 'keep',
  floor: 0.9,
  cases: [
    // Needs the agent now, though it shares no topic with the work.
    { draft: "how's it going", expect: 'steer', must: true },
    { draft: 'what are you working on right now?', expect: 'steer' },
    { draft: 'hello? are you stuck?', expect: 'steer' },
    { draft: 'any blockers so far?', expect: 'steer' },
    { draft: 'how long until this is done?', expect: 'steer' },
    { draft: 'is the build passing?', expect: 'steer' },
    { draft: 'did you see my last message?', accept: ['steer', null] },
    // Changes or stops the current work.
    { draft: "stop, don't push anything yet", expect: 'steer', must: true },
    { draft: 'wait, use semicolons as the delimiter', expect: 'steer' },
    { draft: 'make sure the export respects the date filter', expect: 'steer' },
    { draft: 'after that, also add a PDF export option', expect: 'steer', note: 'Follow-on work folds into the plan.' },
    // Separate work that can wait.
    { draft: 'can you look up the weather in Lisbon next week', expect: 'follow-up', must: true },
    { draft: 'write release notes for the mobile app 2.3 launch', expect: 'follow-up' },
    { draft: 'schedule a dependency audit for the platform repo next week', expect: 'follow-up' },
    { draft: 'draft a blog post about our hiring plans', expect: 'follow-up' },
    { draft: 'can you check whether the docs site is down?', expect: 'follow-up' },
    { draft: "what's the capital of Australia?", expect: 'follow-up' },
    { draft: "separately, please rename the mobile app's settings tab", expect: 'follow-up' },
    // Neither: either keeps the default.
    { draft: 'thanks, looks great so far', accept: ['steer', null] },
  ],
})
