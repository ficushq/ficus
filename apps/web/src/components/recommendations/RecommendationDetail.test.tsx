import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { OperationsRecommendationDetail } from '@ficus/shared'
import { RecommendationDetail } from './RecommendationDetail'
const item: OperationsRecommendationDetail = {
  id: 'r1',
  squadId: 's1',
  policy: 'recommendation-only',
  status: 'resolved',
  confidence: 'low',
  title: 'Review permissions',
  summary: 'Permission failures occurred',
  proposedRemediation: { type: 'review_sandbox_permission', tool: 'bash' },
  recurrence: { occurrences: 1, executions: 1, agents: 1 },
  baseline: { sampleSize: 1, avgDurationMs: 1, avgTokens: 1, failedToolCalls: 1, estimatedAvoidableRetries: 0 },
  comparison: null,
  firstSeenAt: new Date(),
  lastSeenAt: new Date(),
  resolvedAt: new Date(),
  createdAt: new Date(),
  updatedAt: new Date(),
  evidence: [],
  events: [],
}
describe('RecommendationDetail recommendation-only actions', () => {
  test('renders only valid lifecycle controls and never a remediation executor', () => {
    const html = renderToStaticMarkup(<RecommendationDetail item={item} canUpdate onStatus={() => {}} />)
    expect(html).toContain('Reopen')
    expect(html).not.toMatch(/Apply|Run|Install|Execute|acknowledged|dismissed/i)
  })
})
