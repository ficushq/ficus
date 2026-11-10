import {
  addStructuredInputOptions,
  readStructuredInput,
  validateStructuredInput,
  type StructuredInputOptions,
} from '../structured-input'
import { registerWorkstreamFlowCommands } from './workstream-flow'
import { Command } from 'commander'
import {
  formatWorkflowSchemaReference,
  workflowPresetSchema,
  workflowSchemaOverview,
  workflowSourceSchema,
  workflowStepKindReference,
} from '@ficus/shared'
import { apiGet, apiPost, apiPut, apiDelete, apiGetRaw } from '../client'
import { output, outputError } from '../output'

interface TemplateDiffView {
  hasDrift?: boolean
  differences?: Array<{ path: string; label: string }>
  heldBack?: {
    heldAt: string
    blockedBy: 'squad-customizations' | 'invalid-workflow' | null
    invalidReason?: string
    affectedSquads: Array<{ squadName: string; problems: string[] }>
    hiddenSquadCount: number
    parts: Array<{ path: string; label: string }>
  } | null
}

/** Readable summary of a template diff: what differs, and why a code update is held back. */
export function formatTemplateDiff(id: string, diff: TemplateDiffView): string {
  const lines: string[] = []
  const differences = diff.differences ?? []
  if (!diff.hasDrift && !differences.length) lines.push(`Workflow '${id}' matches its code template.`)
  else {
    lines.push(`Workflow '${id}' differs from its code template in:`)
    for (const item of differences) lines.push(`  - ${item.label} (${item.path})`)
  }
  const held = diff.heldBack
  if (held) {
    lines.push('', `A code update to the definition has been held back since ${held.heldAt}.`)
    if (held.parts.length) {
      lines.push('It changes:')
      for (const part of held.parts) lines.push(`  - ${part.label} (${part.path})`)
    }
    if (held.blockedBy === 'squad-customizations') {
      lines.push('It would break saved workflow customizations in:')
      for (const squad of held.affectedSquads) lines.push(`  - ${squad.squadName}: ${squad.problems.join('; ')}`)
      if (held.hiddenSquadCount)
        lines.push(`  - ${held.hiddenSquadCount} squad${held.hiddenSquadCount === 1 ? '' : 's'} you cannot see`)
      lines.push('It applies on the next sync once those squads are updated, or restore it with workflow revert.')
    } else if (held.blockedBy === 'invalid-workflow') {
      lines.push(`Merged with the local edits it is not a valid workflow: ${held.invalidReason ?? 'unknown error'}`)
    } else {
      lines.push('Nothing blocks it any more; it applies on the next sync.')
    }
  }
  return lines.join('\n')
}

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
  for (const name of ['enable', 'disable'] as const) {
    command
      .command(`${name} <id>`)
      .description(`${name} a saved preset`)
      .requiredOption('--revision <revision>', 'Revision from workflow get')
      .action((id: string, options: { revision: string }) =>
        run(async () => {
          deps.output(
            await deps.apiPost(`${path(id)}/disabled`, { revision: options.revision, disabled: name === 'disable' })
          )
        })
      )
  }
  command
    .command('revert <id>')
    .description(
      'Restore the current YAML template, or only the parts named with --path (paths from workflow template-diff). ' +
        'Refuses when this would break saved squad customizations unless --accept-squad-impact is given.'
    )
    .requiredOption('--revision <revision>', 'Revision from workflow get')
    .option('--path <path>', 'Restore only this part; repeat for several', (value: string, all: string[] = []) => [
      ...all,
      value,
    ])
    .option('--accept-squad-impact', 'Restore even though it breaks saved squad workflow customizations')
    .action((id: string, options: { revision: string; path?: string[]; acceptSquadImpact?: boolean }) =>
      run(async () => {
        deps.output(
          await deps.apiPost(`${path(id)}/revert`, {
            revision: options.revision,
            ...(options.path?.length ? { paths: options.path } : {}),
            ...(options.acceptSquadImpact ? { acknowledgeSquadImpact: true } : {}),
          })
        )
      })
    )
  command
    .command('revert-preview <id>')
    .description('Show which squads a revert would break, without applying it')
    .option(
      '--path <path>',
      'Preview restoring only this part; repeat for several',
      (value: string, all: string[] = []) => [...all, value]
    )
    .action((id: string, options: { path?: string[] }) =>
      run(async () => {
        deps.output(
          await deps.apiPost(`${path(id)}/revert/preview`, options.path?.length ? { paths: options.path } : {})
        )
      })
    )
  command
    .command('template-diff <id>')
    .description('Compare a preset with its YAML template')
    .action((id: string) =>
      run(async () => {
        const diff = await deps.apiGet(`${path(id)}/template-diff`)
        deps.output(diff, formatTemplateDiff(id, diff as TemplateDiffView))
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
  // Offline and read-only: generated from the schema this CLI validates with, so it cannot drift from it.
  // A separate command (not resolve --explain) because it needs no input, squad or server.
  command
    .command('schema [step-kind]')
    .description("List workflow step kinds, or a kind's required and optional fields with allowed values")
    .action((kind: string | undefined) =>
      run(async () => {
        const text = formatWorkflowSchemaReference(kind)
        deps.output(kind === undefined ? workflowSchemaOverview() : workflowStepKindReference(kind), text)
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
