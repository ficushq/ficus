import { shareAcrossRequests } from '../../db/query-cancellation'
import { Squad } from '../../entities/Squad'
import { isRemoteSandboxRuntime, getSandboxManager } from '../sandbox/factory'
import type { K8sSandboxManager, SandboxClient } from '../sandbox/k8s'
async function getSquadClientInScope(squadId: string): Promise<SandboxClient | null> {
  // Both remote runtimes (k8s + vm) expose a cached SandboxClient via getClient.
  if (!isRemoteSandboxRuntime()) return null
  const sandboxId = Squad.getSandboxId(squadId)
  const manager = getSandboxManager() as K8sSandboxManager

  // If cached, return immediately (client is ready even if devbox isn't)
  const cached = manager.getClient(sandboxId)
  if (cached) return cached

  // Await the manager's bounded shared ensure instead of retaining one polling timer per request.
  const { ensureSquadSandbox } = await import('../sandbox/ensure')
  const ensure = ensureSquadSandbox(squadId)
  const clientReady = manager.waitForClientReady?.(sandboxId)
  if (clientReady) return Promise.race([clientReady, ensure.then(() => manager.getClient(sandboxId))])
  await ensure
  return manager.getClient(sandboxId)
}

/**
 * A sandbox ensure is shared: concurrent callers join the same wake, and its setup
 * is persisted step by step. It therefore runs outside the cancellation scope of
 * the read that happened to start it (db/query-cancellation.ts), so a reader who
 * leaves never stops a wake that others, or the next reader, depend on.
 */
export function getSquadClient(
  ...args: Parameters<typeof getSquadClientInScope>
): ReturnType<typeof getSquadClientInScope> {
  return shareAcrossRequests(() => getSquadClientInScope(...args))
}
