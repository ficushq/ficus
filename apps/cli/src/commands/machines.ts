import { randomUUID } from 'crypto'
import { Command } from 'commander'
import { apiPost, apiPostSSE } from '../client'
import { output, outputTable, outputError, isJsonMode, isQuietMode } from '../output'

interface MigrateResult {
  moved: boolean
  reason?: string
  activeExecutionCount?: number
}

interface RebalanceMove {
  sandboxId: string
  fromMachineId: string
  toMachineId: string
}

interface RebalanceResponse {
  moves: RebalanceMove[]
  skippedActive: string[]
  unplaceable: string[]
  unresolvable: string[]
  /** `targetMachineId` is the REAL machine a move aimed at — for a
   *  `provision:<n>` planned target, the machine actually provisioned for that
   *  group (absent when that provisioning failed). */
  results: Array<{ sandboxId: string; result: MigrateResult; targetMachineId?: string }>
}

export function registerMachinesCommands(program: Command) {
  const machines = program.command('machines').description('Manage VM sandbox machines (vm runtime)')

  // ficus machines migrate-box <sandboxId> --to <machineId> [--skip-squad] [--force <reason>]
  machines
    .command('migrate-box <sandboxId>')
    .description(
      'Move a sandbox box to a specific machine. A live execution on the box refuses the move — for a SQUAD box ' +
        "that includes every squad member's and squad subagent's turn, not just the box owner's. A SQUAD box moves " +
        'by default, preserving both ~/workspace and ~/.private and stopping its local deployments (--skip-squad refuses instead). ' +
        'Writes not tied to an execution (a detached build, a file-sync) are NOT detected'
    )
    .requiredOption('--to <machineId>', 'Target machine id')
    .option('--skip-squad', 'Refuse to migrate a SQUAD box instead of moving it (default: squad boxes DO move)')
    .option(
      '--force <reason>',
      'DANGEROUS: migrate even though executions are live on this box. The move copies both ~/workspace and ~/.private and then ' +
        'DESTROYS the source box, so anything those turns write to ~/workspace after the copy is read is LOST. ' +
        'For evacuating a machine that is failing anyway. Overrides only the active-execution refusal — the box ' +
        'must still exist, both machines must still be ready, and a concurrent migration still wins'
    )
    .action(async (sandboxId, options) => {
      try {
        // The move streams phase-by-phase (a big squad ~/workspace archive can
        // run many minutes): tail it live so a driving orchestrator can see the
        // current phase without waiting for the end. --json emits one NDJSON
        // record per phase, then the final result record.
        const body = {
          sandboxId,
          ...(options.skipSquad ? { allowSquad: false } : {}),
          ...(options.force ? { force: { reason: options.force, requestId: randomUUID() } } : {}),
        }
        let result: MigrateResult | undefined
        let streamError: string | undefined

        await apiPostSSE(`/api/machines/${options.to}/migrate-box`, body, (event, data) => {
          if (event === 'progress') {
            const progress = JSON.parse(data) as { phase: string }
            if (isJsonMode()) console.log(JSON.stringify({ type: 'progress', ...progress }))
            else if (!isQuietMode()) console.log(`  ${progress.phase}…`)
          } else if (event === 'result') {
            result = JSON.parse(data) as MigrateResult
          } else if (event === 'error') {
            streamError = (JSON.parse(data) as { error: string }).error
          }
        })

        if (streamError) throw new Error(streamError)
        if (!result) throw new Error('migrate-box stream ended without a result')

        if (isJsonMode()) {
          // NDJSON: the final record is the result, on its own line.
          console.log(JSON.stringify({ type: 'result', ...result }))
        } else {
          output(
            result,
            result.moved
              ? `Moved ${sandboxId} to machine ${options.to}`
              : `Not moved: ${result.reason ?? 'unknown reason'}${result.activeExecutionCount === undefined ? '' : ` (${result.activeExecutionCount} active executions)`}`
          )
        }
      } catch (error) {
        outputError(error as Error)
      }
    })

  // ficus machines rebalance [--dry-run]
  machines
    .command('rebalance')
    .description('Re-pack the shared machine fleet (idle non-squad boxes only); --dry-run plans without moving')
    .option('--dry-run', 'Compute and print the plan without moving anything')
    .action(async (options) => {
      try {
        const body = options.dryRun ? { dryRun: true } : {}
        if (!options.dryRun && !isJsonMode() && !isQuietMode()) {
          // Executes are synchronous: each move archives/provisions/restores
          // over SSH, so a big plan holds this request open for a long time.
          console.log(
            'Rebalancing: this can take several minutes and is safe to re-run if interrupted (--dry-run previews).'
          )
        }
        const plan = await apiPost<RebalanceResponse>('/api/machines/rebalance', body)
        if (isJsonMode()) {
          output(plan)
          return
        }
        if (isQuietMode()) return

        const moves = plan.moves ?? []
        const skippedActive = plan.skippedActive ?? []
        const unplaceable = plan.unplaceable ?? []
        const unresolvable = plan.unresolvable ?? []
        const resultBySandbox = new Map((plan.results ?? []).map((r) => [r.sandboxId, r]))

        if (moves.length === 0) {
          console.log('Fleet is balanced: no moves planned')
        } else {
          console.log(options.dryRun ? 'Planned moves (dry run):' : 'Moves:')
          const rows = moves.map((m) => {
            const entry = resultBySandbox.get(m.sandboxId)
            const result = entry?.result
            return {
              sandboxId: m.sandboxId,
              from: m.fromMachineId,
              // Executed moves resolve `provision:<n>` placeholders to the
              // machine actually provisioned; only a dry run (or a failed
              // provision) has no real machine to show.
              to: entry?.targetMachineId ?? m.toMachineId,
              result: options.dryRun ? '' : result ? (result.moved ? 'moved' : (result.reason ?? 'failed')) : '',
            }
          })
          outputTable(rows, options.dryRun ? ['sandboxId', 'from', 'to'] : ['sandboxId', 'from', 'to', 'result'])
        }

        if (skippedActive.length > 0) console.log(`Skipped (active turn): ${skippedActive.join(', ')}`)
        if (unplaceable.length > 0) console.log(`Unplaceable (no capacity): ${unplaceable.join(', ')}`)
        if (unresolvable.length > 0) {
          console.log(`Unresolvable machines (no legal move can fix): ${unresolvable.join(', ')}`)
        }

        if (options.dryRun) {
          console.log(
            `Dry run: ${moves.length} move(s) planned, ` +
              `${unplaceable.length} unplaceable, ${unresolvable.length} unresolvable`
          )
        } else {
          const movedCount = (plan.results ?? []).filter((r) => r.result.moved).length
          console.log(
            `Rebalance done: ${movedCount}/${moves.length} move(s) succeeded, ` +
              `${skippedActive.length} skipped (active), ${unplaceable.length} unplaceable, ` +
              `${unresolvable.length} unresolvable`
          )
        }
      } catch (error) {
        outputError(error as Error)
      }
    })
}
