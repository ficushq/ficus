/**
 * Deterministic per-worktree database identity: Compose project name, port-cache
 * path and free-port allocation. Setup commands and test preloads must use the
 * same root and identity formula to preserve isolation.
 */
import { createHash } from 'crypto'
import { join } from 'path'

/** Deterministic docker-compose project name for a given monorepo root. */
export function testDbProjectName(repoRoot: string): string {
  const dirHash = createHash('sha256').update(repoRoot).digest('hex').slice(0, 8)
  return `ficus-test-${dirHash}`
}

/** Absolute path to the port-cache file this worktree's test-db writes/reads. */
export function testDbPortFile(repoRoot: string): string {
  return join(repoRoot, '.test-db-port')
}

/**
 * Allocate an OS-assigned free TCP port for a fresh test-db container to
 * bind to. Never returns 5432 (the conventional production Postgres port) —
 * a test container accidentally bound there could be mistaken for a real
 * database by another tool probing the default port.
 */
export function findFreeTestDbPort(): number {
  let attempts = 0
  while (attempts < 10) {
    const server = Bun.serve({ port: 0, fetch: () => new Response('') })
    const port = server.port
    server.stop()
    if (!port || isNaN(port)) throw new Error('Failed to find free port')
    if (port === 5432) {
      attempts++
      continue
    }
    return port
  }
  throw new Error('Failed to find non-production port after 10 attempts')
}
