import { describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import type { Context } from 'hono'
import { requireEntityPermission } from '../middleware/require-entity-permission'
import type { Identity } from '../services/rbac'
import { routeParam } from './route-param'

/** A handler helper typed like the ones in routes/: a plain Context, so the path is unknown. */
function echoAgentId(c: Context) {
  return c.json({ agentId: routeParam(c, 'agentId') })
}

describe('routeParam', () => {
  it('returns the value of a param the matched path declares', async () => {
    const app = new Hono().get('/agents/:agentId/files', echoAgentId)
    const res = await app.request('/agents/a-1/files')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ agentId: 'a-1' })
  })

  it('throws, naming the param, when the path does not declare it', async () => {
    let thrown: unknown
    const app = new Hono().get('/agents/:id/files', echoAgentId).onError((error, c) => {
      thrown = error
      return c.text('Internal Server Error', 500)
    })
    const res = await app.request('/agents/a-1/files')
    expect(res.status).toBe(500)
    expect(thrown).toBeInstanceOf(Error)
    expect((thrown as Error).message).toContain('Route parameter "agentId" is missing')
    expect((thrown as Error).message).toContain('GET /agents/a-1/files')
  })

  it('makes a permission loader on a mis-wired route fail closed with 403', async () => {
    const identity: Identity = { type: 'user', userId: 'u-1' }
    let loaded = false
    const app = new Hono()
      .use('*', async (c, next) => {
        c.set('identity', identity)
        await next()
      })
      .get(
        '/agents/:id',
        requireEntityPermission('agents:read', async (c) => {
          routeParam(c, 'agentId')
          loaded = true
          return 'squad-1'
        }),
        (c) => c.text('ok')
      )
    const res = await app.request('/agents/a-1')
    expect(res.status).toBe(403)
    expect(loaded).toBe(false)
  })
})
