/** Native PostgreSQL/session proof only: no SSH, box runtime or host mutation. */
import { createInterface } from 'node:readline'
import { withVmSetupLease, tryWithVmHostBunAdoption } from '../setup-state'
const [role, machineId] = process.argv.slice(2)
if (!role || !machineId) throw new Error('Synthetic role and host identity required')
const emit = (event: string) => console.log(JSON.stringify({ role, pid: process.pid, event }))
const release = Promise.withResolvers<void>()
const input = createInterface({ input: process.stdin })
input.on('line', (line) => {
  if (line === 'release') release.resolve()
})
try {
  await withVmSetupLease(`agent_host_bun_${crypto.randomUUID()}`, async () => {
    const operation = async () => {
      emit('acquired')
      if (role === 'defer') return 'deferred'
      await release.promise
      if (role === 'failure') throw new Error('Synthetic adoption failure')
      return 'ready'
    }
    const result =
      role === 'ordinary'
        ? { acquired: true as const, value: await operation() }
        : await tryWithVmHostBunAdoption(machineId, operation)
    emit(!result.acquired || result.value === 'deferred' ? 'deferred' : 'released')
  })
} catch {
  emit('failed')
} finally {
  input.close()
}
// Every dedicated connection is awaited above; close only this fixture's pools.
process.exit(0)
