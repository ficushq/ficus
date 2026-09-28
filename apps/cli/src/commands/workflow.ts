import {
  addStructuredInputOptions,
  readStructuredInput,
  validateStructuredInput,
  type StructuredInputOptions,
} from '../structured-input'
import { registerWorkstreamFlowCommands } from './workstream-flow'
import { Command } from 'commander'
import { workflowPresetSchema, workflowSourceSchema } from '@ficus/shared'
import { apiGet, apiPost, apiPut, apiDelete, apiGetRaw } from '../client'
import { output, outputError } from '../output'

const defaults = { apiGet, apiPost, apiPut, apiDelete, apiGetRaw, output, outputError, print: console.log }
export type WorkflowDependencies = typeof defaults

/** Structured inputs accept YAML or JSON; mutations always carry the revision the caller inspected. */
export function registerWorkflowCommands(program: Command, deps: WorkflowDependencies = defaults) {
  const command = program
    .command('workflow')
    .description('Manage declarative workflow presets and preview ad hoc flows')
  const path = (id: string) => `/api/workflows/${encodeURIComponent(id)}`
  async function run(action: () => Promise<void>) {
    try {
      await action()
    } catch (error) {
      deps.outputError(error as Error)
    }
  }
  registerWorkstreamFlowCommands(command, deps, true)
  command
    .command('list')
    .description('List workflow presets, including revisions')
    .action(() =>
      run(async () => {
        deps.output(await deps.apiGet('/api/workflows'))
      })
    )
  command
    .command('get <id>')
    .description('Inspect a preset and its current revision')
    .action((id: string) =>
      run(async () => {
        deps.output(await deps.apiGet(path(id)))
      })
    )
  addStructuredInputOptions(command.command('create [file]'))
    .description('Publish a new preset from inline JSON/YAML, stdin, or a saved file')
    .action((file: string | undefined, options: StructuredInputOptions) =>
      run(async () => {
        const preset = validateStructuredInput(workflowPresetSchema, await readStructuredInput(options, file))
        deps.output(await deps.apiPost('/api/workflows', preset))
      })
    )
  addStructuredInputOptions(command.command('update <id> [file]'))
    .description('Replace a preset from inline JSON/YAML, stdin, or a saved file')
    .requiredOption('--revision <revision>', 'Revision from workflow get; conflicts require a fresh review')
    .action((id: string, file: string | undefined, options: StructuredInputOptions & { revision: string }) =>
      run(async () => {
        const preset = validateStructuredInput(workflowPresetSchema, await readStructuredInput(options, file))
        if (preset.id !== id) throw new Error('Workflow ID in the input must match the requested ID')
        deps.output(await deps.apiPut(path(id), { revision: options.revision, preset }))
      })
    )
  command
    .command('delete <id>')
    .description('Delete a custom preset; disable YAML presets instead')
    .requiredOption('--revision <revision>', 'Revision from workflow get')
    .action((id: string, options: { revision: string }) =>
      run(async () => {
        await deps.apiDelete(path(id), { revision: options.revision })
        deps.output({ id, deleted: true })
      })
    )
  for (const name of ['enable', 'disable', 'revert'] as const) {
    command
      .command(`${name} <id>`)
      .description(name === 'revert' ? 'Restore the current YAML template' : `${name} a saved preset`)
      .requiredOption('--revision <revision>', 'Revision from workflow get')
      .action((id: string, options: { revision: string }) =>
        run(async () => {
          deps.output(
            await deps.apiPost(`${path(id)}/${name === 'revert' ? 'revert' : 'disabled'}`, {
              revision: options.revision,
              ...(name === 'revert' ? {} : { disabled: name === 'disable' }),
            })
          )
        })
      )
  }
  command
    .command('template-diff <id>')
    .description('Compare a preset with its YAML template')
    .action((id: string) =>
      run(async () => {
        deps.output(await deps.apiGet(`${path(id)}/template-diff`))
      })
    )
  command
    .command('export <id>')
    .description('Print the effective preset as reusable YAML')
    .action((id: string) =>
      run(async () => {
        deps.print(await (await deps.apiGetRaw(`${path(id)}/export`)).text())
      })
    )
  addStructuredInputOptions(command.command('resolve [file]'))
    .description('Preview a workflow source from inline JSON/YAML, stdin, or a saved file without publishing')
    .requiredOption('--squad <id>', 'Squad where you have permission to create work streams')
    .action((file: string | undefined, options: StructuredInputOptions & { squad: string }) =>
      run(async () => {
        const source = validateStructuredInput(workflowSourceSchema, await readStructuredInput(options, file))
        deps.output(await deps.apiPost('/api/workflows/resolve', { squadId: options.squad, source }))
      })
    )
}
