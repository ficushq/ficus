import { zValidator } from '../lib/zod-validator'
import { Hono } from 'hono'
import { z } from 'zod'
import { requirePermission } from '../middleware'
import {
  applyNixGc as applyNixGcDefault,
  scanOrphanNixStores as scanOrphanNixStoresDefault,
} from '../services/sandbox/docker/nix-gc'
import {
  decodeWorkspaceGcCursor,
  reconcileWorkspaceStubs as reconcileWorkspaceStubsDefault,
} from '../services/squad/workspace-gc'

/**
 * Admin/operator maintenance actions. Gated by `system:cleanup` — the existing
 * operator-cleanup permission (same family as `system:restart`); no new
 * permission scheme is introduced.
 */

const nixGcSchema = z.object({
  // Default (false/absent) is a dry run: scan + report, mutate nothing.
  apply: z.boolean().optional(),
})

const workspaceGcSchema = z.object({
  apply: z.boolean().optional(),
  limit: z.number().int().min(1).max(5_000).optional(),
  cursor: z
    .string()
    .max(255)
    .refine((cursor) => {
      try {
        decodeWorkspaceGcCursor(cursor)
        return true
      } catch {
        return false
      }
    }, 'Invalid workspace GC cursor')
    .optional(),
})

export function createAdminRouter(
  deps: {
    scan?: typeof scanOrphanNixStoresDefault
    apply?: typeof applyNixGcDefault
    workspaceGc?: typeof reconcileWorkspaceStubsDefault
  } = {}
) {
  const app = new Hono()
  const scan = deps.scan ?? scanOrphanNixStoresDefault
  const apply = deps.apply ?? applyNixGcDefault
  const workspaceGc = deps.workspaceGc ?? reconcileWorkspaceStubsDefault

  // POST /api/admin/nix-gc — reclaim orphan/terminated agent Nix stores.
  // Dry-run by default (scan + verdicts + reclaimable total); `{apply:true}`
  // reclaims eligible stores via the #632 primitive and returns reclaimed/failed.
  app.post('/nix-gc', requirePermission('system:cleanup'), zValidator('json', nixGcSchema), async (c) => {
    const { apply: shouldApply } = c.req.valid('json')
    const result = shouldApply ? await apply() : await scan()
    return c.json(result)
  })

  app.post('/workspace-gc', requirePermission('system:cleanup'), zValidator('json', workspaceGcSchema), async (c) => {
    return c.json(await workspaceGc(c.req.valid('json')))
  })

  return app
}

export default createAdminRouter()
