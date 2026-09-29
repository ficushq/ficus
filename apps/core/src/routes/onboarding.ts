/**
 * Onboarding status API — a fresh Ficus instance's derived setup checklist.
 *
 * See docs/history/superpowers/specs/2026-08-05-onboarding-checklist-design.md §2.
 * Gated on the same admin permission surface as the Settings tabs (nothing
 * new): `settings:read` for the status, `settings:write` for the skip flags.
 * The response carries booleans/states only — never secret material.
 */
import { Hono, type Context } from 'hono'
import { requirePermission } from '../middleware/require-permission'
import { auditActor, type Identity } from '../services/rbac'
import {
  getOnboardingStatus,
  isOnboardingItemId,
  OnboardingRequiredItemError,
  setItemSkipped,
} from '../services/onboarding/status'
import { notifyOnboardingChanged } from '../services/onboarding/events'

const app = new Hono()

app.get('/status', requirePermission('settings:read'), async (c) => {
  const status = await getOnboardingStatus()
  return c.json(status)
})

async function handleSkip(c: Context, skipped: boolean) {
  const id = c.req.param('id')
  if (!isOnboardingItemId(id)) {
    return c.json({ error: `Unknown onboarding item '${id}'` }, 400)
  }
  try {
    await setItemSkipped(id, skipped, auditActor(c.get('identity') as Identity))
  } catch (err) {
    if (err instanceof OnboardingRequiredItemError) {
      return c.json({ error: err.message }, 400)
    }
    throw err
  }
  notifyOnboardingChanged()
  return c.json(await getOnboardingStatus())
}

app.post('/items/:id/skip', requirePermission('settings:write'), (c) => handleSkip(c, true))
app.post('/items/:id/unskip', requirePermission('settings:write'), (c) => handleSkip(c, false))

export default app
