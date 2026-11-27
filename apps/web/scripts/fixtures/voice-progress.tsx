/** Fixture-only in-memory response: no account, provider or backend is contacted. */
import { createRoot } from 'react-dom/client'
import { emptySamplingBreakdown, type DerivationProgress } from '@ficus/shared'
import { DeriveVoiceCard } from '../../src/components/voice/DeriveVoiceCard'
import { applyResolvedTheme } from '../../src/theme/apply'
import { FICUS_THEME } from '../../src/theme/registry'
import '../../src/index.css'

applyResolvedTheme(document.documentElement, FICUS_THEME, 'light')
let controller: ReadableStreamDefaultController<Uint8Array>
let seq = 0
let signal: AbortSignal
let snapshot = emptySamplingBreakdown()
function send(event: DerivationProgress) {
  controller.enqueue(
    new TextEncoder().encode(
      `event: derivation\ndata: ${JSON.stringify({ version: 1, runId: 'fixture', seq: ++seq, ...event })}\n\n`
    )
  )
}
const result = {
  login: 'octo',
  draft: { base: 'Lead with the result. Use complete sentences.', surfaces: {} },
  observations: ['Lead with the result.'],
  exemplars: [],
  sampling: {
    filters: {},
    counts: {
      collected: 30,
      kept: 20,
      droppedByFilter: { date: 5, repository: 2 },
      droppedAsToolAuthored: 1,
      droppedAsTemplate: 2,
    },
    dateRange: {},
    publicRepositories: ['example/library'],
    privateRepositories: ['example/private-library'],
    pagingCapped: false,
  },
  bytes: 51,
  maxBytes: 2000 as const,
}
window.fetch = (async (input, init) => {
  if (!String(input).endsWith('/voice/derive')) throw new Error('Unexpected fixture request')
  signal = init!.signal!
  seq = 0
  return new Response(
    new ReadableStream({
      start(c) {
        controller = c
      },
    }),
    { headers: { 'Content-Type': 'text/event-stream' } }
  )
}) as typeof fetch
const fixture = {
  collecting() {
    send({ type: 'started' })
    send({ type: 'phase', phase: 'collecting' })
    send({
      type: 'repositories',
      repositories: [
        { name: 'example/private-library', activity: 'activity_read' },
        { name: 'example/library', activity: 'reading_commits' },
      ],
    })
    snapshot = emptySamplingBreakdown()
    snapshot.bySurface['issue-comments'] = {
      seen: 30,
      kept: 20,
      dropped: {
        date: 5,
        repository: 2,
        tool_authored: 1,
        template_or_short: 2,
        surface_limit: 0,
        sample_limit: 0,
        input_byte_limit: 0,
      },
    }
    snapshot.totals = snapshot.bySurface['issue-comments']
    send({ type: 'counts', provisional: true, ...snapshot })
  },
  drafting() {
    send({ type: 'phase', phase: 'drafting' })
  },
  complete() {
    send({ type: 'counts', provisional: false, ...snapshot })
    send({ type: 'phase', phase: 'validating' })
    send({ type: 'finding', index: 0, text: result.observations[0]! })
    send({ type: 'complete', result })
    controller.close()
  },
  fail() {
    send({ type: 'error', error: { code: 'derivation_invalid_output', reason: 'not_json' } })
    controller.close()
  },
  aborted() {
    return signal.aborted
  },
}
Object.assign(window, { voiceFixture: fixture })
createRoot(document.getElementById('root')!).render(
  <main style={{ height: '100%', overflow: 'auto', padding: 16 }}>
    <div style={{ maxWidth: 850, margin: '0 auto' }}>
      <DeriveVoiceCard
        target={{ kind: 'squad', squadId: 'fixture' }}
        linkedLogin="octo"
        onUseDraft={() => {
          throw new Error('No fixture saves are permitted')
        }}
      />
    </div>
  </main>
)
