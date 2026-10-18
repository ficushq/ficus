import { describe, expect, test } from 'bun:test'
import { createDatabaseHealthRouter } from './health-db'

const request = (probe: () => Promise<unknown>, timeoutMs = 50) =>
  createDatabaseHealthRouter(probe, timeoutMs).request('/')

describe('GET /health/db', () => {
  test('a reachable database is ok', async () => {
    const res = await request(async () => [{ '?column?': 1 }])
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'ok', database: 'ok' })
    expect(res.headers.get('Cache-Control')).toBe('no-store')
  })

  test('a failing query is 503 and never echoes the error', async () => {
    const res = await request(async () => {
      throw new Error('connect ECONNREFUSED 10.0.0.5:5432 password=hunter2')
    })
    expect(res.status).toBe(503)
    const body = await res.text()
    expect(JSON.parse(body)).toEqual({ status: 'error', database: 'unreachable' })
    expect(body).not.toContain('ECONNREFUSED')
    expect(body).not.toContain('hunter2')
  })

  test('a query that hangs past the timeout is 503', async () => {
    const started = Date.now()
    const res = await request(() => new Promise(() => {}), 30)
    expect(res.status).toBe(503)
    expect(Date.now() - started).toBeLessThan(1_000)
  })
})
