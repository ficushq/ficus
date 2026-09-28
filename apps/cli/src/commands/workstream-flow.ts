import {
  addStructuredInputOptions,
  readStructuredInput,
  validateStructuredInput,
  type StructuredInputOptions,
} from '../structured-input'
import { Command } from 'commander'
import { workflowCommandSchema } from '@ficus/shared'
import { apiGet, apiPost } from '../client'
import { output, outputError } from '../output'

const defaults = { apiGet, apiPost, output, outputError }
export type WorkstreamFlowDependencies = typeof defaults

/** Execution belongs to a work stream; hidden legacy names support existing agent inbox messages. */
export function registerWorkstreamFlowCommands(
  command: Command,
  deps: WorkstreamFlowDependencies = defaults,
  legacy = false
) {
  async function run(action: () => Promise<void>) {
    try {
      await action()
    } catch (error) {
      deps.outputError(error as Error)
    }
  }
  command
    .command(`${legacy ? 'run' : 'flow'} <id>`, { hidden: legacy })
    .description('Inspect the current flow, version, attempts, and return obligations')
    .action((id: string) =>
      run(async () => {
        deps.output(await deps.apiGet(`/api/workflows/runs/${encodeURIComponent(id)}`))
      })
    )
  addStructuredInputOptions(command.command('advance <id>', { hidden: legacy }))
    .description('Complete, return, delegate, rework, or revise a flow using a versioned command')
    .option('--request-id <id>', 'Stable UUID for retrying this exact command')
    .addHelpText(
      'after',
      '\nThe command must include action, expectedVersion, attemptId, and action-specific fields (e.g. outcome and evidence for complete).'
    )
    .action((id: string, options: StructuredInputOptions & { requestId?: string }) =>
      run(async () => {
        const value = validateStructuredInput(workflowCommandSchema, await readStructuredInput(options))
        deps.output(
          await deps.apiPost(`/api/workflows/runs/${encodeURIComponent(id)}/advance`, {
            command: value,
            requestId: options.requestId ?? crypto.randomUUID(),
          })
        )
      })
    )
  command
    .command('finish <id>', { hidden: legacy })
    .description('Evaluate delivery policy and finish a ready flow')
    .requiredOption('--version <version>', 'Version from workstream flow')
    .action((id: string, options: { version: string }) =>
      run(async () => {
        const version = Number(options.version)
        if (!Number.isSafeInteger(version) || version < 0) throw new Error('Version must be a nonnegative integer')
        deps.output(await deps.apiPost(`/api/workflows/runs/${encodeURIComponent(id)}/finish`, { version }))
      })
    )
}
