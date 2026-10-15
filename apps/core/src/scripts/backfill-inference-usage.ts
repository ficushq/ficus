import { backfillInferenceUsage } from '../services/inference-usage/backfill'
import { parseUsageBackfillArgs, type UsageBackfillCliArgs } from './backfill-execution-usage'

const USAGE =
  'Usage: bun usage:ledger-backfill [--squad <uuid>] [--agent <uuid>]... [--apply]\n' +
  '  Imports usage recorded before the inference cost ledger existed (execution deltas, session totals,\n' +
  '  decision costs) into the ledger. Idempotent. Without --apply this is a dry run.\n' +
  '  The worker runs it once on its own; use this to re-check or to import a squad or agent again.'

export async function runInferenceUsageBackfillCli(
  args: readonly string[],
  run = backfillInferenceUsage,
  write: (line: string) => void = console.log
): Promise<number> {
  let parsed: UsageBackfillCliArgs
  try {
    parsed = parseUsageBackfillArgs(args)
  } catch {
    write(USAGE)
    return 1
  }
  const summary = await run({
    apply: parsed.apply,
    ...(parsed.squadId ? { squadId: parsed.squadId } : {}),
    ...(parsed.agentIds.length ? { agentIds: parsed.agentIds } : {}),
  })
  const rows = summary.executionRows + summary.sessionGapRows + summary.decisionRows
  write(
    `${parsed.apply ? `Wrote ${summary.inserted} new ledger row(s) of ${rows} found` : `Would write up to ${rows} ledger row(s)`} ` +
      `(${summary.executionRows} execution, ${summary.sessionGapRows} session-total, ${summary.decisionRows} decision) ` +
      `from ${summary.agentsScanned} agent(s), for usage before ${summary.cutoff}.`
  )
  if (!parsed.apply && rows > 0) write('Re-run with --apply to write.')
  return 0
}

if (import.meta.main) {
  runInferenceUsageBackfillCli(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error(error)
      process.exit(1)
    })
}
