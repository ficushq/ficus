import { defineDecisionEval } from './decisions/evals/define'
import { SCREENSHOTS } from './screenshot-filing.decision-eval'
import { buildScreenshotWorkStreamDecision, pickWorkStream, type ScreenshotWorkStream } from './screenshot-filing'

const STREAMS: ScreenshotWorkStream[] = [
  {
    id: '5c4ee000-0000-4000-8000-0000000000a1',
    title: 'Checkout total shows NaN',
    description: 'On the checkout page the order total shows NaN and Pay now is disabled.',
  },
  {
    id: '5c4ee000-0000-4000-8000-0000000000a2',
    title: 'Plan the spring sale',
    description: 'Which widgets to discount, banner copy and the email schedule.',
  },
]

/** The title of the open work stream it is about, or null for none of them. */
type Outcome = string | null

export default defineDecisionEval<{ image: keyof typeof SCREENSHOTS }, Outcome>({
  name: 'screenshot-work-stream',
  purpose: 'screenshot-filing',
  description: "Which of the guessed squad's open work streams a screenshot is about, if any.",
  build: ({ image }) => ({
    request: buildScreenshotWorkStreamDecision({
      image: SCREENSHOTS[image],
      squadName: 'Widget Shop',
      workStreams: STREAMS,
    }),
  }),
  decide: (answers) => pickWorkStream(answers.work_stream, STREAMS)?.title ?? null,
  caseName: ({ image }) => image,
  label: (outcome) => outcome ?? 'none',
  cases: [
    { image: 'checkout', expect: 'Checkout total shows NaN', must: true },
    { image: 'product', expect: null, must: true, note: 'A new bug: neither stream is about it.' },
  ],
})
