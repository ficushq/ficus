import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  CODE_HOST_DELIVERY_PRESENTATION_CASES,
  WORK_STREAM_PRESENTATION_CASES,
} from '../../../../packages/shared/src/test-fixtures/work-stream-presentation'
import { WorkStreamStatusBadges } from './WorkStreamStatusBadges'
import { getWsDisplayState, WS_STATUS_BADGE_COLORS } from '../lib/workStreamStatusPresentation'
import { webStatus } from '../lib/statusPresentation'

for (const row of [...WORK_STREAM_PRESENTATION_CASES, ...CODE_HOST_DELIVERY_PRESENTATION_CASES]) {
  test(`visible status matrix: ${row.name}`, () => {
    const html = renderToStaticMarkup(<WorkStreamStatusBadges workStream={row.facts} />)
    expect(html).toContain(row.label)
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
