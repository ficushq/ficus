import { Hono } from 'hono'
import { terminalManager } from '../services/sandbox/docker/terminal'
import { canAccessSandboxTerminal } from '../services/sandbox/terminal-access'
import type { Identity } from '../services/rbac'

/** Squad and agent boxes only; every other sandbox kind is refused here. */
async function canAccessSandbox(identity: Identity | undefined, sandboxId: string): Promise<Response | null> {
  if (!identity) return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 })
  return (await canAccessSandboxTerminal(identity, sandboxId))
    ? null
    : new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403 })
}

export const terminalRouter = new Hono()
  .get('/sessions', async (c) => {
    const sandboxId = c.req.query('sandboxId')
    if (!sandboxId) {
      return c.json({ error: 'sandboxId query parameter is required' }, 400)
    }
    const denial = await canAccessSandbox(c.get('identity'), sandboxId)
    if (denial) return denial
    c.set('authzChecked', true)
    return c.json(terminalManager.listSessions(sandboxId))
  })
  .delete('/sessions/:sessionId', async (c) => {
    const identity: Identity | undefined = c.get('identity')
    if (!identity) return c.json({ error: 'Unauthorized' }, 401)
    const sessionId = c.req.param('sessionId')
    const session = terminalManager.getSession(sessionId)
    if (!session) {
      return c.json({ error: 'Forbidden' }, 403)
    }
    const denial = await canAccessSandbox(identity, session.sandboxId)
    if (denial) return denial
    c.set('authzChecked', true)
    terminalManager.killSession(sessionId)
    return c.json({ success: true })
  })
