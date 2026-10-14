/**
 * Paraphrased real chat endings (from an audit of consultant and manager chats), used by the
 * pre-check unit tests and by the optional live prompt check (`live-eval.ts`). No real names,
 * links or identifiers.
 */
export interface ReplySuggestionFixture {
  name: string
  /** The person's previous message. */
  human: string
  /** The agent's last message. */
  agent: string
  /** Whether the cheap pre-check should pass it on to the model. */
  precheck: boolean
  /** Whether chips are expected from the model (live check only); omitted when either is fine. */
  chips?: boolean
  /** A pattern at least one chip should match (live check only). */
  expectChip?: RegExp
}

export const REPLY_SUGGESTION_FIXTURES: readonly ReplySuggestionFixture[] = [
  {
    name: 'offer to start work',
    human: 'The export button crashes on Safari when the list is empty.',
    agent:
      'I found the cause: the export handler reads the first row without checking the list is empty.\n\nThe fix is small: guard the empty case and show a toast instead.\n\nWant me to open a work stream for this?',
    precheck: true,
    chips: true,
    expectChip: /yes|start|go/i,
  },
  {
    name: 'go-ahead with a trailing status line',
    human: 'Can you clean up the old preview deployments?',
    agent:
      'There are 14 preview deployments older than 30 days. Deleting them frees about 3 GB.\n\nShall I proceed?\n\n_Status: idle, nothing running._',
    precheck: true,
    chips: true,
  },
  {
    name: 'A or B with a recommendation',
    human: 'How should we store the reply chips?',
    agent:
      'Two options:\n\n**A. Message metadata**: no migration, travels with the message.\n**B. A new table**: queryable, but needs a migration and cleanup.\n\nI recommend A. A or B?',
    precheck: true,
    chips: true,
    expectChip: /recommend|^A\b|metadata/i,
  },
  {
    name: 'numbered options without a question mark',
    human: 'The nightly job keeps timing out.',
    agent:
      'I can see three ways forward:\n\n1. Raise the timeout to 30 minutes\n2. Split the job into two smaller jobs\n3. Move it to the larger runner\n\nLet me know which you prefer.',
    precheck: true,
    chips: true,
  },
  {
    name: 'confirm a plan',
    human: 'Plan the migration to the new auth flow.',
    agent:
      'Plan:\n- Add the new login route behind a flag\n- Migrate sessions in the background\n- Remove the old route after a week\n\nSound good?',
    precheck: true,
    chips: true,
  },
  {
    name: 'two-part question',
    human: 'The repair stream failed again.',
    agent:
      'The repair failed because its branch was deleted. I can recreate the branch and rerun the repair, and also clean up the two stale streams it left behind. Should I do both, or only the repair?',
    precheck: true,
    chips: true,
  },
  {
    name: 'asks for a fact the model cannot know',
    human: 'Set up push notifications.',
    agent: 'Happy to set that up. Which platform are you targeting, iOS or Android?',
    precheck: true,
    expectChip: /ios|android/i,
  },
  {
    name: 'asks for a link',
    human: 'Review the design doc.',
    agent: 'Sure. What is the link to the design doc?',
    precheck: true,
    chips: false,
  },
  {
    name: 'greeting',
    human: 'hi',
    agent: 'Hi! How can I help today?',
    precheck: true,
    chips: false,
  },
  {
    name: 'question mark only inside a URL',
    human: 'Where is the stream?',
    agent: 'Done. The work stream is open at https://example.test/work?ws=42 and the first step is running.',
    precheck: false,
  },
  {
    name: 'question mark only in a query string without a scheme',
    human: 'Link it please.',
    agent: 'Linked it in the overview (see /work?ws=42). It is running now.',
    precheck: false,
  },
  {
    name: 'question mark only in code',
    human: 'What does the null check do?',
    agent:
      'It uses optional chaining:\n\n```ts\nconst name = user?.profile?.name ?? "anonymous"\n```\n\nSo a missing profile falls back to anonymous.',
    precheck: false,
  },
  {
    name: 'question mark only in inline code',
    human: 'Why did it crash?',
    agent: 'The crash came from `items?.length` being undefined. I fixed it and the tests pass.',
    precheck: false,
  },
  {
    name: 'quoted question',
    human: 'What did the reviewer say?',
    agent:
      'The reviewer wrote:\n\n> Is this cache ever invalidated?\n\nI answered in the thread and added an invalidation test. All checks are green.',
    precheck: false,
  },
  {
    name: 'bold heading question answered in place',
    human: 'Do we still need the legacy importer?',
    agent:
      '**Is it needed?** No. Nothing has called it since the new importer shipped.\n\n**Can it be removed safely?** Yes, the last caller was deleted in the spring.\n\nI removed it in the cleanup branch.',
    precheck: false,
  },
  {
    name: 'markdown heading question',
    human: 'Summarize the incident.',
    agent:
      '## What went wrong?\n\nThe queue filled up after the deploy.\n\n## Fix\n\nWe raised the limit and added an alert.',
    precheck: false,
  },
  {
    name: 'status update needing approval elsewhere',
    human: 'How is the release going?',
    agent: 'The release branch is built and the PR is up. It needs your approval in the review step before it ships.',
    precheck: false,
  },
  {
    name: 'question far above the end',
    human: 'Can you look at the flaky test?',
    agent:
      'Is it flaky everywhere? I checked: only on Linux.\n\nThe cause is a fixed sleep in the fixture.\n\nI replaced it with a readiness wait.\n\nIt now passes 50 runs in a row.',
    precheck: false,
  },
  {
    name: 'recap of earlier unanswered questions',
    human: 'ok',
    agent:
      'Noted.\n\nStill waiting on you:\n- Which region should the new database use?\n- Should the old bucket be deleted?',
    precheck: true,
    chips: false,
  },
]
