import { expect, test } from 'bun:test'
import {
  LIVE_MAX_ARRIVALS,
  liveRowProps,
  planLiveListMotion,
  sameLiveRows,
  type LiveRowAfter,
  type LiveRowBefore,
} from './liveListMotion'

const ROW_HEIGHT = 40

function before(rows: Array<[string, string | null]>): Map<string, LiveRowBefore> {
  return new Map(rows.map(([key, status], index) => [key, { top: index * ROW_HEIGHT, left: 0, status }]))
}

function after(rows: Array<[string, string | null]>, { visible = true } = {}): LiveRowAfter[] {
  return rows.map(([key, status], index) => ({ key, status, top: index * ROW_HEIGHT, left: 0, visible }))
}

test('nothing animates when order, membership and statuses are unchanged', () => {
  const rows: Array<[string, string]> = [
    ['a', 'in_progress'],
    ['b', 'queued'],
  ]
  expect(sameLiveRows(before(rows), after(rows))).toBe(true)
  expect(planLiveListMotion(before(rows), after(rows))).toEqual({ moves: [], arrivals: [], statusChanges: [] })
})

test('a reorder moves each row from its old place to its new one', () => {
  const plan = planLiveListMotion(
    before([
      ['a', null],
      ['b', null],
      ['c', null],
    ]),
    after([
      ['c', null],
      ['a', null],
      ['b', null],
    ])
  )
  // Each delta is old minus new, so the row starts where it was and slides home.
  expect(plan.moves).toEqual([
    { key: 'c', dx: 0, dy: 80 },
    { key: 'a', dx: 0, dy: -40 },
    { key: 'b', dx: 0, dy: -40 },
  ])
  expect(plan.arrivals).toEqual([])
})

test('an arriving row is highlighted and the rows it pushes down slide', () => {
  const plan = planLiveListMotion(
    before([
      ['a', null],
      ['b', null],
    ]),
    after([
      ['new', null],
      ['a', null],
      ['b', null],
    ])
  )
  expect(plan.arrivals).toEqual(['new'])
  expect(plan.moves.map((move) => [move.key, move.dy])).toEqual([
    ['a', -40],
    ['b', -40],
  ])
})

test('a removed row lets the rows below slide up, with nothing highlighted', () => {
  const plan = planLiveListMotion(
    before([
      ['a', null],
      ['b', null],
      ['c', null],
    ]),
    after([
      ['a', null],
      ['c', null],
    ])
  )
  expect(plan.arrivals).toEqual([])
  expect(plan.moves).toEqual([{ key: 'c', dx: 0, dy: 40 }])
})

test('a status change emphasizes that row only; rows without a status never count', () => {
  const plan = planLiveListMotion(
    before([
      ['a', 'in_progress'],
      ['b', 'queued'],
      ['c', null],
    ]),
    after([
      ['a', 'in_review'],
      ['b', 'queued'],
      ['c', 'queued'],
    ])
  )
  expect(plan.statusChanges).toEqual(['a'])
  expect(plan.moves).toEqual([])
})

test('rows whose new place is off screen do not move', () => {
  const plan = planLiveListMotion(
    before([
      ['a', null],
      ['b', null],
    ]),
    after(
      [
        ['b', null],
        ['a', null],
      ],
      { visible: false }
    )
  )
  expect(plan.moves).toEqual([])
})

test('a row from far away starts at most the viewport height from its new place', () => {
  const plan = planLiveListMotion(
    new Map([
      ['b', { top: 0, left: 0, status: null }],
      ['a', { top: 5000, left: 0, status: null }],
    ]),
    [
      { key: 'a', status: null, top: 0, left: 0, visible: true },
      { key: 'b', status: null, top: 40, left: 0, visible: true },
    ],
    { maxDistance: 800 }
  )
  expect(plan.moves).toEqual([
    { key: 'a', dx: 0, dy: 800 },
    { key: 'b', dx: 0, dy: -40 },
  ])
})

test('rows that only shift (no change to order, membership or status) do not move', () => {
  // A row above grew on its own, for example: that is not a live change of the list.
  const plan = planLiveListMotion(new Map([['a', { top: 100, left: 0, status: null }]]), [
    { key: 'a', status: null, top: 0, left: 0, visible: true },
  ])
  expect(plan.moves).toEqual([])
})

test('many rows arriving at once is a reload, not a live change: nothing animates', () => {
  const previous: Array<[string, string | null]> = [['a', 'queued']]
  const arrivals: Array<[string, string | null]> = Array.from({ length: LIVE_MAX_ARRIVALS + 1 }, (_, index) => [
    `new-${index}`,
    null,
  ])
  const plan = planLiveListMotion(before(previous), after([...arrivals, ['a', 'in_progress']]))
  expect(plan).toEqual({ moves: [], arrivals: [], statusChanges: [] })

  const fewer = planLiveListMotion(before(previous), after([...arrivals.slice(1), ['a', 'queued']]))
  expect(fewer.arrivals).toHaveLength(LIVE_MAX_ARRIVALS)
})

test('row props carry the key and, when given, the status', () => {
  expect(liveRowProps('a')).toEqual({ 'data-live-row': 'a' })
  expect(liveRowProps('a', 'queued')).toEqual({ 'data-live-row': 'a', 'data-live-status': 'queued' })
})
