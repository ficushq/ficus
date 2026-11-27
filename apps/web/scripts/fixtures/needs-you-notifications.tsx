// The real Needs-you notices and theme styles over a stand-in page; no backend needed.
// ?theme=<built-in id>&appearance=light|dark picks the theme. The pending list starts empty, then
// gains a review and a question, the way a live update would deliver them.
import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router'
import type { PendingAction } from '@ficus/shared'
import { NeedsYouNotifications } from '../../src/components/NeedsYouNotifications'
import { applyResolvedTheme } from '../../src/theme/apply'
import { findWebTheme } from '../../src/theme/registry'
import { questionAction, waitAction } from '@ficus/shared/test-fixtures/pending-actions'
import '../../src/index.css'

const params = new URLSearchParams(location.search)
const theme = findWebTheme(params.get('theme'))
applyResolvedTheme(
  document.documentElement,
  theme,
  theme.kind === 'unified' ? 'constant' : params.get('appearance') === 'dark' ? 'dark' : 'light'
)

const incoming: PendingAction[] = [
  waitAction('w1', { createdAt: '2026-11-26T12:01:00.000Z' }),
  questionAction(
    'q1',
    { createdAt: '2026-11-26T12:02:00.000Z' },
    { questionData: { questions: [{ id: 'q', type: 'text', question: 'Should a 409 from the processor retry too?' }] } }
  ),
]

function Fixture() {
  const [pending, setPending] = useState<PendingAction[]>([])
  useEffect(() => {
    const timer = setTimeout(() => setPending(incoming), 50)
    return () => clearTimeout(timer)
  }, [])
  return (
    <MemoryRouter>
      {/* Inline height: Tailwind does not scan scripts/, so only classes the app itself uses exist. */}
      <div className="relative flex flex-col overflow-hidden bg-page text-primary" style={{ height: '100vh' }}>
        <header className="border-b border-panel-border p-4 text-sm font-semibold">Ficus</header>
        <div className="relative grow">
          <NeedsYouNotifications
            dependencies={{
              usePendingActions: () => ({ data: pending }),
              usePreferences: () => ({ pushEnabled: true, mutedEvents: [] }),
              useWindowFocus: () => ({ isFocused: () => true, since: 0 }),
              subscribePushChecks: () => () => {},
              osNotificationReplacesCard: () => false,
              timeoutMs: 600_000,
            }}
          />
          <main className="p-6">
            <h1 className="ficus-page-title">Feed</h1>
            <p className="mt-2 text-sm text-secondary">Stand-in page content under the notices.</p>
          </main>
        </div>
      </div>
    </MemoryRouter>
  )
}

createRoot(document.getElementById('root')!).render(<Fixture />)
