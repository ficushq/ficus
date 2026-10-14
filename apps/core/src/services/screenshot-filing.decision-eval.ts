import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DecisionImage } from '@ficus/shared'
import { defineDecisionEval } from './decisions/evals/define'
import { decisionImageCopy } from './images/decision-image'
import { buildScreenshotDecision, readScreenshotGuess, type ScreenshotSquad } from './screenshot-filing'

const FIXTURES = join(import.meta.dir, 'decisions/evals/fixtures')

/** The copy a decision model is shown, made the way filing makes it. */
export async function screenshotFixture(name: string): Promise<DecisionImage> {
  const copy = await decisionImageCopy(readFileSync(join(FIXTURES, name)))
  if (!copy) throw new Error(`${name} is too small to judge`)
  return copy.image
}

export const SCREENSHOTS = {
  checkout: await screenshotFixture('widget-shop-checkout-nan.png'),
  product: await screenshotFixture('widget-shop-product-broken.png'),
}

export const SCREENSHOT_SQUADS: ScreenshotSquad[] = [
  {
    id: '5c4ee000-0000-4000-8000-000000000001',
    name: 'Widget Shop',
    purpose: 'The Widget Shop storefront: catalog, cart, checkout and payments.',
    openWorkStreams: 2,
  },
  {
    id: '5c4ee000-0000-4000-8000-000000000002',
    name: 'Chlea',
    purpose: 'Chlea, a music therapy app: playlists for sessions and a listening journal.',
    openWorkStreams: 0,
  },
  {
    id: '5c4ee000-0000-4000-8000-000000000003',
    name: 'Marketing',
    purpose: 'Blog posts, newsletters, social media and campaigns.',
    openWorkStreams: 1,
  },
]

type Outcome = { kind: string; squad: string | null; action: string } | null

export default defineDecisionEval<{ image: keyof typeof SCREENSHOTS; userNote?: string }, Outcome>({
  name: 'screenshot-filing',
  purpose: 'screenshot-filing',
  description: 'What a dropped screenshot shows, which squad it belongs to, and what to do with it.',
  build: ({ image, userNote }) => ({
    request: buildScreenshotDecision({ image: SCREENSHOTS[image], note: userNote, squads: SCREENSHOT_SQUADS }),
    context: { squads: SCREENSHOT_SQUADS },
  }),
  // Saved corrections carry the squads they were asked about.
  decide: (answers, context) => {
    const guess = readScreenshotGuess(answers, (context as { squads: ScreenshotSquad[] }).squads)
    return guess ? { kind: guess.kind.id, squad: guess.squad?.name ?? null, action: guess.action.id } : null
  },
  caseName: ({ image, userNote }) => (userNote ? `${image}: ${userNote}` : image),
  label: (outcome) => (outcome ? `${outcome.kind} in ${outcome.squad ?? 'no squad'}, ${outcome.action}` : 'no guess'),

  cases: [
    { image: 'checkout', expect: { kind: 'bug', squad: 'Widget Shop' }, must: true },
    { image: 'product', expect: { kind: 'bug', squad: 'Widget Shop' }, must: true },
    {
      image: 'product',
      userNote: 'just keeping this for the redesign mood board, nothing to fix',
      expect: { squad: 'Widget Shop', action: 'just_save' },
      note: "The user's note says what to do.",
    },
  ],
})
