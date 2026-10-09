import { ASSISTANT_ROUTING_MIN_CONFIDENCE } from '@ficus/shared'
import { defineDecisionEval } from '../decisions/evals/define'
import { routingEvalContext, type RoutingEvalContext } from './routing-eval-capture'
import {
  assistantRoutingVerdict,
  buildRoutingRequest,
  interpretKindAnswer,
  interpretRoutingAnswer,
  type RecentEntry,
  type RoutingSquad,
} from './assistant-routing'

const SQUADS: RoutingSquad[] = [
  {
    id: '1c4ea001-0000-4000-8000-000000000001',
    name: 'Chlea',
    purpose: 'Chlea, a music therapy app: playlists for sessions and a listening journal.',
  },
  {
    id: '2b5d0e02-0000-4000-8000-000000000002',
    name: 'Widget Shop',
    purpose: 'The Widget Shop storefront: catalog, cart, checkout and payments.',
  },
  {
    id: '3a7f8c03-0000-4000-8000-000000000003',
    name: 'Marketing',
    purpose: 'Blog posts, newsletters, social media and campaigns.',
  },
]

/** `squad:<name>`, `instance`, `general`, `follow-up` (keeps the conversation's earlier routing), or null (no hint). */
type Outcome = string | null

export default defineDecisionEval<{ text: string; recent?: RecentEntry[] }, Outcome>({
  name: 'assistant-routing',
  purpose: 'assistant-routing',
  description: 'Which squad (or Ficus itself, or general work) an Assistant user message is for.',
  build: ({ text, recent = [] }) => {
    const { request, keys } = buildRoutingRequest({ text, recent, squads: SQUADS, withKind: true })
    return { request, context: routingEvalContext(keys, recent.length > 0) }
  },
  decide: (answers, context) => {
    const { keys, earlierRouting } = context as RoutingEvalContext
    const scope = interpretRoutingAnswer(answers.scope, new Map(Object.entries(keys)))
    const verdict = assistantRoutingVerdict({ hint: scope?.hint ?? null, kind: interpretKindAnswer(answers.kind) })
    // As the turn does: a follow-up keeps earlier routing only when the conversation has some.
    if (verdict.followUp && earlierRouting) return 'follow-up'
    if (!verdict.hint) return null
    return verdict.hint.scope === 'squad' ? `squad:${verdict.hint.squadName}` : verdict.hint.scope
  },
  thresholds: { kind: [ASSISTANT_ROUTING_MIN_CONFIDENCE], scope: [ASSISTANT_ROUTING_MIN_CONFIDENCE] },
  caseName: ({ text }) => text,
  label: (outcome) => outcome ?? 'no hint',
  floor: 0.8,
  cases: [
    { text: 'The playlist builder crashes when I add a track', expect: 'squad:Chlea', must: true },
    { text: 'Add a coupon code field to the checkout page', expect: 'squad:Widget Shop' },
    { text: 'Write a blog post announcing our spring sale', expect: 'squad:Marketing' },
    {
      text: 'How is the listening journal coming along?',
      expect: 'squad:Chlea',
      note: 'A question about a squad is for that squad.',
    },
    { text: 'Add a new user and give them the reviewer role', expect: 'instance', must: true },
    { text: 'Connect our GitHub organization to Ficus', expect: 'instance' },
    { text: 'Research the best note-taking apps and summarize them for me', accept: ['general', null] },
    { text: "What's a good recipe for banana bread?", accept: ['general', null] },
    {
      text: 'also make sure it works offline',
      recent: [
        { role: 'user', text: 'The playlist builder crashes when I add a track' },
        { role: 'assistant', text: 'Chlea is on it: I asked them to fix the crash.' },
      ],
      expect: 'follow-up',
      must: true,
    },
    {
      text: 'Widget Shop',
      recent: [
        { role: 'user', text: 'Someone should add gift cards' },
        { role: 'assistant', text: 'Which squad should build gift cards?' },
      ],
      accept: ['squad:Widget Shop', 'follow-up'],
      note: 'Answering the question names the squad.',
    },
    {
      text: 'Actually, write the launch newsletter for it too',
      recent: [
        { role: 'user', text: 'Add a coupon code field to the checkout page' },
        { role: 'assistant', text: 'Widget Shop is adding the coupon field.' },
      ],
      expect: 'squad:Marketing',
      note: 'New work for a different squad, even mid-conversation.',
    },
  ],
})
