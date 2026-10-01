#!/usr/bin/env bun
/** Maintenance-only operator; API and worker must have the documented runtime
 * start guards and be stopped. Secrets come from the units' actual EnvironmentFile.
 * export FICUS_ROOT=/opt/ficus-core/current
 * cd "$FICUS_ROOT/apps/core"
 * FICUS_BR_BOX=all bun --env-file /opt/ficus-core/.env \
 *   --env-file /etc/ficus/managed.env dist/box-reprovision.js
 */
import { runBoxReprovision, ReprovisionError } from './services/machines/box-reprovision'
import {
  assertLocalReprovisionMaintenance,
  createRemoteReprovisionRuntime,
  createReprovisionJournal,
  runningReprovisionProbeCommand,
} from './services/machines/box-reprovision-runtime'

export function parseBoxReprovisionTarget(env: Record<string, string | undefined>): string {
  const value = env.FICUS_BR_BOX ?? ''
  if (!/^[A-Za-z0-9._:-]+$/.test(value)) throw new ReprovisionError('invalid-FICUS_BR_BOX')
  return value
}
async function main(): Promise<number> {
  const target = parseBoxReprovisionTarget(process.env)
  await assertLocalReprovisionMaintenance()
  const { getSecretStore } = await import('./services/secrets/store')
  const queries = await import('./services/machines/queries')
  const { db, machineBoxes, executions } = await import('./db')
  const { eq, and, inArray, isNull } = await import('drizzle-orm')
  const { withVmSetupLease } = await import('./services/sandbox/vm/setup-state')
  const { defaultSshRunner: runner } = await import('./services/machines/ssh')
  const { installBoxOnMachine } = await import('./services/machines/box-manager')
  const { ensureMachineArtifacts } = await import('./services/machines/machine-artifacts-registry')
  const { requiresMachineLayoutMigration } = await import('./services/machines/machine-layout-preflight')
  const { currentBootstrapVersion } = await import('./services/machines/bootstrap')
  await getSecretStore().initialize()
  // A session-owned advisory lease serializes all invocations and releases on
  // process death. API/worker start guards exclude their lifecycle/turn writers.
  return withVmSetupLease('operator:box-reprovision', () =>
    runBoxReprovision(target, {
      assertMaintenance: async () => {
        await assertLocalReprovisionMaintenance()
        const active = await db
          .select({ id: executions.id })
          .from(executions)
          .where(inArray(executions.status, ['running', 'stopping', 'waiting-sandbox']))
          .limit(1)
        if (active.length) throw new ReprovisionError('active-executions')
      },
      listBoxes: queries.listAllMachineBoxes,
      getMachine: queries.getMachine,
      requiresMigration: async (machine) =>
        machine.bootstrapVersion !== currentBootstrapVersion() ||
        (await requiresMachineLayoutMigration(machine, runner)),
      ...createRemoteReprovisionRuntime(runner),
      ensureArtifacts: ensureMachineArtifacts,
      install: (opts) => installBoxOnMachine(opts, { runner }),
      checkRunning: async (machine, box) => {
        const config = `header = "Authorization: Bearer ${box.authToken!.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"\n`
        const result = await runner.run(machine, runningReprovisionProbeCommand(box), {
          stdin: config,
          timeoutMs: 60_000,
        })
        if (result.exitCode !== 0) throw new ReprovisionError('running-auth-probe-failed')
      },
      invalidateStamp: async (box) => {
        const changed = await db
          .update(machineBoxes)
          .set({ provisionedSpecHash: null })
          .where(
            and(
              eq(machineBoxes.sandboxId, box.sandboxId),
              eq(machineBoxes.machineId, box.machineId),
              eq(machineBoxes.unixUser, box.unixUser),
              eq(machineBoxes.port, box.port),
              eq(machineBoxes.status, box.status),
              eq(machineBoxes.migrating, false),
              box.reconcilableSpecHash === null
                ? isNull(machineBoxes.reconcilableSpecHash)
                : eq(machineBoxes.reconcilableSpecHash, box.reconcilableSpecHash),
              eq(machineBoxes.authToken, box.authToken!)
            )
          )
          .returning({ id: machineBoxes.sandboxId })
        if (changed.length !== 1) throw new ReprovisionError('box-changed-before-stamp-invalidation')
      },
      journal: createReprovisionJournal(),
      print: (line) => console.log(line),
    })
  )
}
if (import.meta.main) {
  main()
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error(
        `BOX_REPROVISION operator failed ${error instanceof ReprovisionError ? error.message : 'initialization-failed'}`
      )
      process.exit(1)
    })
}
