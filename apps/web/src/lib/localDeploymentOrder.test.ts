import { describe, expect, test } from 'bun:test'
import type { LocalDeploymentStatus } from '@ficus/shared'
import { sortLocalDeployments } from './localDeploymentOrder'

function app(id: string, status: string, updatedAt = '2026-01-01T00:00:00Z', name = id) {
  return { id, name, status: status as LocalDeploymentStatus, updatedAt }
}

const ids = (apps: { id: string }[]) => apps.map((a) => a.id)

describe('sortLocalDeployments', () => {
  test('orders by status: running, in progress, unhealthy, crashed, stopped', () => {
    const sorted = sortLocalDeployments([
      app('stopped', 'stopped'),
      app('crashed', 'crashed'),
      app('unhealthy', 'unhealthy'),
      app('restarting', 'restarting'),
      app('running', 'running'),
    ])
    expect(ids(sorted)).toEqual(['running', 'restarting', 'unhealthy', 'crashed', 'stopped'])
  })

  test('puts the running app above stopped ones regardless of API order', () => {
    const sorted = sortLocalDeployments([
      app('docmost', 'stopped', '2026-01-03T00:00:00Z'),
      app('everynoise-supervisor', 'stopped', '2026-01-02T00:00:00Z'),
      app('chlea-core-demo-preview', 'running', '2026-01-01T00:00:00Z'),
    ])
    expect(ids(sorted)).toEqual(['chlea-core-demo-preview', 'docmost', 'everynoise-supervisor'])
  })

  test('treats starting and restarting as the same group, newest first', () => {
    const sorted = sortLocalDeployments([
      app('old-starting', 'starting', '2026-01-01T00:00:00Z'),
      app('new-restarting', 'restarting', '2026-01-02T00:00:00Z'),
    ])
    expect(ids(sorted)).toEqual(['new-restarting', 'old-starting'])
  })

  test('within a status, most recently updated first', () => {
    const sorted = sortLocalDeployments([
      app('older', 'running', '2026-01-01T00:00:00Z'),
      app('newest', 'running', '2026-01-03T00:00:00Z'),
      app('middle', 'running', '2026-01-02T00:00:00Z'),
    ])
    expect(ids(sorted)).toEqual(['newest', 'middle', 'older'])
  })

  test('breaks remaining ties by name, then id', () => {
    const sorted = sortLocalDeployments([
      app('b-2', 'stopped', '2026-01-01T00:00:00Z', 'beta'),
      app('a-1', 'stopped', '2026-01-01T00:00:00Z', 'alpha'),
      app('b-1', 'stopped', '2026-01-01T00:00:00Z', 'beta'),
    ])
    expect(ids(sorted)).toEqual(['a-1', 'b-1', 'b-2'])
  })

  test('lists an unknown status last, and an unparseable timestamp last in its group', () => {
    const sorted = sortLocalDeployments([
      app('mystery', 'paused'),
      app('stopped', 'stopped'),
      app('no-time', 'running', 'not a date'),
      app('running', 'running'),
    ])
    expect(ids(sorted)).toEqual(['running', 'no-time', 'stopped', 'mystery'])
  })

  test('does not mutate the input', () => {
    const input = [app('stopped', 'stopped'), app('running', 'running')]
    sortLocalDeployments(input)
    expect(ids(input)).toEqual(['stopped', 'running'])
  })
})
