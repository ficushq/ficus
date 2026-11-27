import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  CODE_HOST_DELIVERY_PRESENTATION_CASES,
  WORK_STREAM_PRESENTATION_CASES,
} from '../../../../packages/shared/src/test-fixtures/work-stream-presentation'
import { WorkStreamStatusBadges } from './WorkStreamStatusBadges'
import { getWsDisplayState, WS_STATUS_BADGE_COLORS } from '../lib/workStreamStatusPresentation'
import { webStatus } from '../lib/statusPresentation'
import { compileUtilities } from '../test/tailwind'

for (const row of [...WORK_STREAM_PRESENTATION_CASES, ...CODE_HOST_DELIVERY_PRESENTATION_CASES]) {
  test(`visible status matrix: ${row.name}`, () => {
    const html = renderToStaticMarkup(<WorkStreamStatusBadges workStream={row.facts} />)
    expect(html).toContain(row.label)
    if (row.secondaryLabel) {
      expect(html).toContain(row.secondaryLabel)
      expect(html).toContain(`Delivery: ${row.secondaryLabel}`)
      expect(html.indexOf(row.label)).toBeLessThan(html.indexOf(row.secondaryLabel))
      expect(renderToStaticMarkup(<WorkStreamStatusBadges workStream={row.facts} showPrimary={false} />)).toContain(
        row.secondaryLabel
      )
    }
    expect(WS_STATUS_BADGE_COLORS[getWsDisplayState(row.facts)]).toBe(webStatus(row.role).badgeColor)
  })
}

test('delivery-external pills show the derived label from server explanation facts', () => {
  const base = { status: 'active' as const, openWaits: [] }
  const merge = renderToStaticMarkup(
    <WorkStreamStatusBadges
      workStream={{
        ...base,
        delivery: {
          kind: 'external',
          explanation: { codeHostReason: 'awaiting-merge', pullRequests: [{ number: 212, state: 'open' }] },
        },
      }}
    />
  )
  expect(merge).toContain('Awaiting merge')
  expect(merge).not.toContain('Awaiting Code Host')
  const ci = renderToStaticMarkup(
    <WorkStreamStatusBadges
      workStream={{
        ...base,
        delivery: {
          kind: 'external',
          explanation: {
            pullRequests: [{ number: 212, state: 'open' }],
            codeHostReason: 'ci-pending',
            gates: { checksState: 'pending' },
          },
        },
      }}
    />
  )
  expect(ci).toContain('Awaiting CI')
  // Unknown evidence keeps the generic label, as do other delivery kinds.
  expect(
    renderToStaticMarkup(<WorkStreamStatusBadges workStream={{ ...base, delivery: { kind: 'external' } }} />)
  ).toContain('Awaiting Code Host')
  expect(
    renderToStaticMarkup(<WorkStreamStatusBadges workStream={{ ...base, delivery: { kind: 'merge' } }} />)
  ).toContain('Merge Pull Request')
})

test('queued delivery approval retains its independent Parked badge only with a real wait', () => {
  const delivery = { kind: 'approval' as const, approvalWaitId: 'approval' }
  const openWaits = [{ id: 'approval', type: 'manual' as const }]
  const parked = renderToStaticMarkup(<WorkStreamStatusBadges workStream={{ status: 'queued', delivery, openWaits }} />)
  expect(parked).toContain('Approve Delivery')
  expect(parked).toContain('Parked')
  expect(WS_STATUS_BADGE_COLORS.delivery_approval).toBe(webStatus('review').badgeColor)
  const active = renderToStaticMarkup(<WorkStreamStatusBadges workStream={{ status: 'active', delivery, openWaits }} />)
  expect(active).toContain('Approve Delivery')
  expect(active).not.toContain('Parked')
  for (const facts of [
    { status: 'queued' as const, openWaits: [] },
    { status: 'queued' as const, delivery, openWaits: [] },
  ]) {
    expect(renderToStaticMarkup(<WorkStreamStatusBadges workStream={facts} />)).not.toContain('Parked')
  }
})

test('Parked preserves pause and omitted-waits compatibility without reviving explicitly cleared waits', () => {
  const paused = renderToStaticMarkup(
    <WorkStreamStatusBadges workStream={{ status: 'queued', pause: true, openWaits: [] }} />
  )
  expect(paused).toContain('Paused')
  expect(paused).toContain('Parked')
  const legacy = { status: 'queued' as const, derivedState: 'in_review' as const }
  expect(renderToStaticMarkup(<WorkStreamStatusBadges workStream={legacy} />)).toContain('Parked')
  expect(renderToStaticMarkup(<WorkStreamStatusBadges workStream={{ ...legacy, openWaits: [] }} />)).not.toContain(
    'Parked'
  )
})

test('pill rows color the delivery label by its role or leave it to the pull request badge', () => {
  const ciFailed = {
    status: 'active' as const,
    derivedState: 'in_progress' as const,
    openWaits: [],
    delivery: { kind: 'failure' as const, explanation: { codeHostReason: 'ci-failed' as const } },
  }
  const text = renderToStaticMarkup(<WorkStreamStatusBadges workStream={ciFailed} />)
  expect(text).toContain('<span class="text-xs text-secondary" title="Delivery: CI failed">')
  const pill = renderToStaticMarkup(<WorkStreamStatusBadges workStream={ciFailed} deliveryLabel="pill" />)
  expect(pill).not.toContain('text-xs text-secondary')
  expect(pill).toMatch(/<span class="[^"]*text-status-danger-badge-fg[^"]*" title="Delivery: CI failed">/)
  expect(pill).toContain('<span class="sr-only">Delivery: </span>CI failed')
  const external = renderToStaticMarkup(
    <WorkStreamStatusBadges
      workStream={{ ...ciFailed, delivery: { kind: 'external', explanation: { codeHostReason: 'ci-pending' } } }}
      deliveryLabel="pill"
    />
  )
  expect(external).toMatch(/text-status-external-wait-badge-fg[^"]*" title="Delivery: Awaiting CI"/)
  const none = renderToStaticMarkup(<WorkStreamStatusBadges workStream={ciFailed} deliveryLabel="none" />)
  expect(none).toContain('In Progress')
  expect(none).not.toContain('CI failed')
  // Board cards hide the primary pill: with nothing else to show, they render nothing.
  expect(
    renderToStaticMarkup(<WorkStreamStatusBadges workStream={ciFailed} showPrimary={false} deliveryLabel="none" />)
  ).toBe('')
})

test('"Review queued" stays on text surfaces and leaves pill rows', () => {
  const gate = { id: 'gate', type: 'manual' as const, flowAttemptId: 2, workflowHumanGate: true }
  const question = { id: 'question', type: 'question' as const, flowAttemptId: 2 }
  const facts = { status: 'active' as const, openWaits: [question, gate] }
  expect(renderToStaticMarkup(<WorkStreamStatusBadges workStream={facts} />)).toContain('Review queued')
  expect(renderToStaticMarkup(<WorkStreamStatusBadges workStream={facts} showPrimary={false} />)).toContain(
    'Review queued'
  )
  const row = renderToStaticMarkup(<WorkStreamStatusBadges workStream={facts} showQueuedReview={false} />)
  expect(row).toContain('Waiting on Answer')
  expect(row).not.toContain('Review queued')
})

test('pill rows show "Review queued" only on a device that cannot hover', async () => {
  const gate = { id: 'gate', type: 'manual' as const, flowAttemptId: 2, workflowHumanGate: true }
  const question = { id: 'question', type: 'question' as const, flowAttemptId: 2 }
  const facts = { status: 'active' as const, openWaits: [question, gate] }
  const html = renderToStaticMarkup(<WorkStreamStatusBadges workStream={facts} showQueuedReview="touch" />)
  const classes = html.match(/class="([^"]*)" data-testid="queued-review-label">Review queued</)?.[1].split(' ')
  expect(classes).toEqual(['text-xs', 'text-secondary', 'hidden', '[@media(hover:none)]:inline'])
  // The production Tailwind build turns the variant into a hover:none media query that shows it again.
  const shown: string[] = []
  ;(await compileUtilities(classes!)).walkAtRules('media', (media) => {
    if (media.params === '(hover:none)') media.walkDecls('display', (decl) => void shown.push(decl.value))
  })
  expect(shown).toEqual(['inline'])
  expect(renderToStaticMarkup(<WorkStreamStatusBadges workStream={facts} />)).toContain(
    '<span class="text-xs text-secondary" data-testid="queued-review-label">Review queued</span>'
  )
})
