import { eq } from 'drizzle-orm'
import { db, agents, localDeployments } from '../../db'
import { hasPermission } from '../rbac/permissions'
import { toLocalDeployment } from './local-deployment-service'
import { resolvePublicAppUrl } from '../../lib/public-app-url'

const DEPLOYMENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Resolve a preview for the runner-owned calling agent, never a model-supplied
 * identity or origin. Check live RBAC and deployment state on every navigation.
 * The returned capability is for the internal browser transport ONLY: callers
 * must not include it (or errors that echo it) in tool results or logs.
 */
export async function resolveLocalDeploymentBrowserUrl(agentId: string, deploymentId: string): Promise<string | null> {
  // No privileged arbitrary-URL or ambiguous UUID-prefix lookup.
  if (typeof deploymentId !== 'string' || !DEPLOYMENT_ID.test(deploymentId)) return null
  const [caller] = await db.select({ squadId: agents.squadId }).from(agents).where(eq(agents.id, agentId)).limit(1)
  if (!caller) return null
  const [deployment] = await db.select().from(localDeployments).where(eq(localDeployments.id, deploymentId)).limit(1)
  if (
    !deployment ||
    deployment.archivedAt ||
    deployment.status === 'stopped' ||
    (deployment.expiresAt && deployment.expiresAt.getTime() <= Date.now()) ||
    !deployment.browserAccessToken
  )
    return null
  if (
    !(await hasPermission({ type: 'agent', agentId, squadId: caller.squadId }, 'deployments:read', deployment.squadId))
  ) {
    return null
  }

  const issuedUrl = toLocalDeployment(deployment).urlPathOrHost
  try {
    // Hosted app URLs are already absolute. Path-mode deployments require the
    // operator's browser-reachable origin; never guess localhost or accept one
    // from tool parameters, and never concatenate an absolute hosted URL.
    const url = issuedUrl.startsWith('/') ? new URL(issuedUrl, resolvePublicAppUrl()) : new URL(issuedUrl)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null
    return url.href
  } catch {
    return null
  }
}
