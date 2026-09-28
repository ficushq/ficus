#!/usr/bin/env bun
/**
 * Operator box control, bundled as `dist/box-control.js` so it exists on an
 * artifact install. Run on the tenant Core VM from `/opt/tau-core`, where Bun
 * loads Core's `.env` (database and secret store):
 *
 *   FICUS_BC_SANDBOX_ID=<sandboxId> FICUS_BC_ACTION=<status|stop|start|restart|processes|kill> \
 *     [FICUS_BC_PID=<pid> FICUS_BC_SIGNAL=<TERM|INT|KILL>] bun current/apps/core/dist/box-control.js
 *
 * The platform's `scripts/box-control.ts` is the usual caller.
 */
import './boot/legacy-env'
import { parseBoxControlRequest, runBoxControl } from './services/machines/box-control'

async function main(): Promise<number> {
  let request
  try {
    request = parseBoxControlRequest(process.env)
  } catch (error) {
    console.error((error as Error).message)
    return 2
  }
  // Loaded only after the request validates: these connect to the database
  // and secret store as they load.
  const { getSecretStore } = await import('./services/secrets/store')
  const { getMachine, getMachineBox } = await import('./services/machines/queries')
  const { defaultSshRunner } = await import('./services/machines/ssh')
  await getSecretStore().initialize()
  const result = await runBoxControl(request, { getMachineBox, getMachine, runner: defaultSshRunner })
  if (result.stdout) process.stdout.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)
  return result.exitCode
}

if (import.meta.main) {
  main()
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error(error instanceof Error ? error.message : error)
      process.exit(1)
    })
}
