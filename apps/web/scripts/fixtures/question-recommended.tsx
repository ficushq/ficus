// The real agent question card and theme styles, with a synthetic question whose options carry a
// recommendation: a select question and a text question with suggested answers.
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { AgentQuestion } from '@ficus/shared'
import { AgentQuestionCard } from '../../src/components/AgentQuestionCard'
import { queries } from '../../src/queryOptions'
import { applyResolvedTheme } from '../../src/theme/apply'
import { BUILT_IN_THEMES, FICUS_THEME } from '../../src/theme/registry'
import '../../src/index.css'

const params = new URLSearchParams(location.search)
const theme = BUILT_IN_THEMES.find((candidate) => candidate.id === params.get('theme')) ?? FICUS_THEME
applyResolvedTheme(
  document.documentElement,
  theme,
  theme.kind === 'unified' ? 'constant' : params.get('appearance') === 'dark' ? 'dark' : 'light'
)

const question: AgentQuestion = {
  id: 'q-1',
  agentId: 'agent-1',
  squadId: 'squad-1',
  ownerUserId: null,
  status: 'open',
  answer: null,
  answeredByUserId: null,
  createdAt: '2026-11-27T04:00:00Z',
  answeredAt: null,
  questionData: {
    questions: [
      {
        id: 'rollout',
        type: 'select',
        question: 'How should I roll out the new billing export?',
        context: 'The export passed every check on staging. About 40 teams still use the old one each week.',
        options: [
          { value: 'all', label: 'Switch every team over today' },
          {
            value: 'gradual',
            label: 'Move 10% of teams this week, the rest next week',
            recommended: true,
            reason: 'It limits the impact if a large account finds a problem.',
          },
          { value: 'wait', label: 'Wait until after the quarter closes' },
        ],
      },
      {
        id: 'notice',
        type: 'text',
        question: 'Who should I tell before it starts?',
        options: [
          { value: 'support', label: 'The support team' },
          { value: 'owners', label: 'Each team owner', recommended: true, reason: 'They run the exports.' },
        ],
      },
    ],
  },
}

const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } })
client.setQueryData(queries.voice.status().queryKey, { enabled: false } as never)

createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={client}>
    <main className="min-h-full bg-page p-4 text-primary">
      <div id="shot" className="mx-auto max-w-xl">
        <AgentQuestionCard question={question} />
      </div>
    </main>
  </QueryClientProvider>
)
