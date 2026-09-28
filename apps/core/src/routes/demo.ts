import { Hono } from 'hono'
import { requirePermission } from '../middleware'
import { isDemoReviewerAccessEnabled } from '../services/demo/access'
import {
  DemoSeedError,
  revokeDemoReviewerDevices as revokeDemoReviewerDevicesDefault,
  seedDemoInstance as seedDemoInstanceDefault,
} from '../services/demo/seed'

/**
 * Operator side of reviewer access (`ficus demo …`). Everything here is admin
 * only (`system:demo`) and answers 404 unless the instance opted in with
 * FICUS_DEMO_REVIEWER_ACCESS, so an ordinary instance has no demo surface at all.
 */
export function createDemoRouter(
  deps: {
    enabled?: () => boolean
    seed?: typeof seedDemoInstanceDefault
    revokeDevices?: typeof revokeDemoReviewerDevicesDefault
  } = {}
) {
  const app = new Hono()
  const enabled = deps.enabled ?? isDemoReviewerAccessEnabled
  const seed = deps.seed ?? seedDemoInstanceDefault
  const revokeDevices = deps.revokeDevices ?? revokeDemoReviewerDevicesDefault

  app.use('*', requirePermission('system:demo'))
  app.use('*', async (c, next) => {
    if (!enabled()) return c.json({ error: 'Not found' }, 404)
    return next()
  })

  // POST /api/demo/seed — create or refresh the demo account and its world (idempotent).
  app.post('/seed', async (c) => {
    try {
      return c.json(await seed())
    } catch (error) {
      if (error instanceof DemoSeedError) return c.json({ error: error.message }, 409)
      throw error
    }
  })

  // POST /api/demo/revoke-devices — sign every reviewer device out.
  app.post('/revoke-devices', async (c) => {
    return c.json({ revoked: await revokeDevices() })
  })

  return app
}

export default createDemoRouter()
