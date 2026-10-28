import { describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { z } from 'zod'
import { zValidator } from './zod-validator'

const schema = z.object({ name: z.string(), size: z.number().int().optional() }).strict()

function app() {
  const app = new Hono()
  app.post('/plain', zValidator('json', schema), (c) => {
    const body: { name: string; size?: number } = c.req.valid('json')
    return c.json({ received: body })
  })
  app.get('/query', zValidator('query', z.object({ limit: z.coerce.number().int().max(10) })), (c) =>
    c.json({ limit: c.req.valid('query').limit })
  )
  app.post(
    '/hooked',
    zValidator('json', schema, (result, c) => {
      if (!result.success) return c.json({ error: 'Invalid request', code: 'invalid_request' }, 400)
    }),
    (c) => c.json({ received: c.req.valid('json') })
  )
  app.post(
    '/observing-hook',
    zValidator('json', schema, () => undefined),
    (c) => c.json({ received: c.req.valid('json') })
  )
  return app
}

function post(path: string, body: unknown) {
  return app().request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('zValidator', () => {
  test('a failed validation answers 400 with the issues, as on zod 3', async () => {
    const response = await post('/plain', { size: 1.5, extra: true })
    expect(response.status).toBe(400)
    const body = (await response.json()) as { success: boolean; error: { name: string; issues: unknown[] } }
    expect(body.success).toBe(false)
    expect(body.error.name).toBe('ZodError')
    expect(body.error.issues).toEqual([
      expect.objectContaining({ code: 'invalid_type', path: ['name'], expected: 'string' }),
      expect.objectContaining({ code: 'invalid_type', path: ['size'], expected: 'int' }),
      expect.objectContaining({ code: 'unrecognized_keys', path: [], keys: ['extra'] }),
    ])
    for (const issue of body.error.issues as { message: unknown }[]) expect(typeof issue.message).toBe('string')
  })

  test('valid input reaches the handler parsed', async () => {
    const response = await post('/plain', { name: 'a', size: 2 })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ received: { name: 'a', size: 2 } })
    const query = await app().request('/query?limit=3')
    expect(await query.json()).toEqual({ limit: 3 })
    const invalidQuery = await app().request('/query?limit=30')
    expect(invalidQuery.status).toBe(400)
    expect(((await invalidQuery.json()) as { error: { issues: { path: unknown }[] } }).error.issues[0]!.path).toEqual([
      'limit',
    ])
  })

  test("a route's own hook answers first", async () => {
    const response = await post('/hooked', {})
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'Invalid request', code: 'invalid_request' })
    expect((await post('/hooked', { name: 'a' })).status).toBe(200)
  })

  test('a hook that returns nothing still gets the standard failure body', async () => {
    const response = await post('/observing-hook', {})
    expect(response.status).toBe(400)
    expect(((await response.json()) as { error: { issues: unknown[] } }).error.issues).toHaveLength(1)
  })
})
