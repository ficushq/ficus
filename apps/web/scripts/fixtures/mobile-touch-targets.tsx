// Inline text controls and standalone controls with made-up data, for check-mobile-touch-targets.ts.
// The chat header rows are the real components; the checker answers their /api/* requests.
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { PermissionsProvider } from '../../src/hooks/usePermissions'
import { AgentSlotWaitStatus } from '../../src/components/AgentSlotWaitStatus'
import { AgentMonitorStatus } from '../../src/components/AgentMonitorStatus'
import { ThinkingSection } from '../../src/components/MessageContent'
import { CloseIcon, LinkIcon, PencilIcon } from '../../src/components/icons'
import '../../src/index.css'

if (new URLSearchParams(location.search).get('appearance') === 'dark') document.documentElement.classList.add('dark')

const cache = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })

createRoot(document.getElementById('root')!).render(
  <MemoryRouter>
    <QueryClientProvider client={cache}>
      <PermissionsProvider
        usePermissions={() => ({ permissions: ['*'], can: () => true, isLoading: false, isError: false })}
      >
        <div className="min-h-screen bg-page p-4 text-primary">
          <div className="ficus-panel overflow-hidden" data-fixture="chat-header">
            {/* As in AgentChat's header status. */}
            <AgentSlotWaitStatus agentId="agent-1" squadId="squad-1" isIdle />
            <AgentMonitorStatus agentId="agent-1" squadId="squad-1" />
            {/* The same row shape with a link and a link-style button in the text. */}
            <div className="flex min-w-0 items-start gap-2 px-3 py-2 text-xs text-secondary" data-fixture="link-row">
              <LinkIcon className="mt-0.5 h-3 w-3 shrink-0" />
              <span className="min-w-0 [overflow-wrap:anywhere]">
                Waiting on{' '}
                <a href="#review" className="inline-flex items-center text-accent-light hover:underline">
                  Garden planner review
                </a>{' '}
                ·{' '}
                <button type="button" className="ficus-button ficus-button-link">
                  Details
                </button>
              </span>
            </div>
          </div>

          <div className="ficus-panel mt-4 space-y-3 p-3" data-fixture="standalone">
            <div className="flex items-center gap-2 text-sm">
              <span className="flex-1">Icon buttons</span>
              <button type="button" aria-label="Rename" className="ficus-button ficus-button-ghost rounded p-1">
                <PencilIcon className="h-3.5 w-3.5" />
              </button>
              <button type="button" aria-label="Close" className="ficus-button ficus-button-ghost rounded p-1">
                <CloseIcon className="h-3 w-3" />
              </button>
            </div>
            <div className="flex items-center gap-2 text-sm">
              <span className="flex-1">Compact actions</span>
              <button
                type="button"
                className="ficus-button ficus-button-secondary rounded px-2 py-0.5 text-xs font-medium"
              >
                Restart
              </button>
              <button
                type="button"
                className="ficus-button ficus-button-danger rounded px-2 py-0.5 text-xs font-medium"
              >
                Stop
              </button>
            </div>
            <div className="flex items-center gap-2 text-sm">
              <span className="flex-1">Toggle</span>
              {/* As in the slot pool settings: a fixed-size custom control. */}
              <button
                type="button"
                role="switch"
                aria-checked="true"
                aria-label="Enabled"
                className="relative inline-flex h-5 w-9 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent bg-accent"
              >
                <span className="pointer-events-none inline-block h-4 w-4 translate-x-4 rounded-full bg-white shadow" />
              </button>
            </div>
            <ThinkingSection thinking="Comparing the two export formats." durationMs={2400} />
          </div>
        </div>
      </PermissionsProvider>
    </QueryClientProvider>
  </MemoryRouter>
)
