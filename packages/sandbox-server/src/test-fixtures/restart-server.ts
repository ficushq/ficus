// A real executor boundary for Core integration tests. Keep imports inside this
// project's compilation boundary; Core launches this fixture as a child process.
import { join } from 'node:path'
import { BashInvocationRegistry } from '../services/bash-invocation-registry'
import { cancelBashInvocation, handleBash, reconcileBashRecord } from '../services/bash'

const root = process.env.FICUS_RESTART_TEST_ROOT
if (process.env.NODE_ENV !== 'test' || !root) throw new Error('This fixture requires an isolated test root')
const registry = new BashInvocationRegistry({ runtimeDir: join(root, 'registry'), reconcile: reconcileBashRecord })
await registry.reconcileAll()
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(request) {
    const path = new URL(request.url).pathname
    if (request.method !== 'POST') return new Response('Not found', { status: 404 })
    if (path === '/bash/cancel') {
      const body = (await request.json()) as Parameters<typeof handleBash>[0] & {
        reason: Parameters<typeof cancelBashInvocation>[1]
        restart?: Parameters<typeof cancelBashInvocation>[3]
      }
      return Response.json(await cancelBashInvocation(body.invocationId!, body.reason, registry, body.restart))
    }
    if (path === '/bash') {
      const body = (await request.json()) as Parameters<typeof handleBash>[0]
      return handleBash({ ...body, sourceEnv: false, activateDevbox: false }, registry)
    }
    return new Response('Not found', { status: 404 })
  },
})
console.log(JSON.stringify({ port: server.port }))
process.once('SIGTERM', async () => {
  try {
    await registry.terminateAll()
    server.stop(true)
    process.exit(0)
  } catch (error) {
    console.error('Owned executor fixture cleanup failed', error)
    server.stop(true)
    process.exit(1)
  }
})
