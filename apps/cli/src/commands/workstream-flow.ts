import {
  addStructuredInputOptions,
  readStructuredInput,
  validateStructuredInput,
  type StructuredInputOptions,
} from '../structured-input'
import { readFile, stat } from 'node:fs/promises'
import { basename } from 'node:path'
import { Command } from 'commander'
import { WORKFLOW_ATTEMPT_ATTACHMENT_LIMIT, workflowCommandSchema } from '@ficus/shared'
import { apiGet, apiPost, apiPostForm } from '../client'
import { output, outputError } from '../output'

const defaults = { apiGet, apiPost, output, outputError }
export type WorkstreamFlowDependencies = typeof defaults & { apiPostForm?: typeof apiPostForm }

/** Core's default per-file cap (INBOX_MAX_ATTACHMENT_BYTES); the server enforces its configured value. */
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024

/** The part of `workstream flow` that decides whether attaching still makes sense. */
type FlowSnapshot = { version: number; state: { attempts: Array<{ id: number; status: string }> } }

function collect(value: string, previous: string[]) {
  return [...previous, value]
}

/** Read every attachment up front, so a bad file is reported before anything is uploaded. */
async function readAttachments(paths: string[]): Promise<Array<{ path: string; bytes: Uint8Array<ArrayBuffer> }>> {
  const files = []
  for (const path of paths) {
    const info = await stat(path).catch((error: Error) => {
      throw new Error(`Cannot read attachment ${path}: ${error.message}`)
    })
    if (!info.isFile()) throw new Error(`${path} is not a file`)
    if (info.size > MAX_ATTACHMENT_BYTES)
      throw new Error(`${path} is larger than the ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB attachment limit`)
    if (info.size === 0) throw new Error(`${path} is empty`)
    files.push({ path, bytes: new Uint8Array(await readFile(path)) })
  }
  return files
}

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
    .description('Inspect the current flow, version, attempts, effective active outcomes, and return obligations')
    .action((id: string) =>
      run(async () => {
        deps.output(await deps.apiGet(`/api/workflows/runs/${encodeURIComponent(id)}`))
      })
    )
  addStructuredInputOptions(command.command('advance <id>', { hidden: legacy }))
    .description('Complete, return, delegate, rework, or revise a flow using a versioned command')
    .option('--request-id <id>', 'Stable UUID for retrying this exact command')
    .option(
      '--attach <path>',
      `Attach a file to the handoff for reviewers (repeatable; complete only; at most ${WORKFLOW_ATTEMPT_ATTACHMENT_LIMIT} files of 10 MB)`,
      collect,
      []
    )
    .addHelpText(
      'after',
      '\nThe command must include action, expectedVersion, attemptId, and action-specific fields (e.g. outcome and evidence for complete).\nAuthorized revise active=keep refreshes outcomes for kept running attempts while preserving their initial brief and session. The response outcomeUpdates lists affected attempt/agent IDs; record scope and steer every affected active agent. Inspect activeOutcomes with workstream flow.\nUse active=restart only for deliberate cancellation and a new attempt with a fresh session, even with reuse-within-stream. Revised instructions apply to future attempts, not a kept initial brief.\n--attach uploads each file to the completing attempt before the command is sent; if any upload fails, the attempt is not advanced.'
    )
    .action((id: string, options: StructuredInputOptions & { requestId?: string; attach: string[] }) =>
      run(async () => {
        const value = validateStructuredInput(workflowCommandSchema, await readStructuredInput(options))
        if (options.attach.length) {
          if (value.action !== 'complete') throw new Error('--attach is only available when completing an attempt')
          if (options.attach.length > WORKFLOW_ATTEMPT_ATTACHMENT_LIMIT)
            throw new Error(`At most ${WORKFLOW_ATTEMPT_ATTACHMENT_LIMIT} files can be attached to one handoff`)
          const current = await deps.apiGet<FlowSnapshot | null>(`/api/workflows/runs/${encodeURIComponent(id)}`)
          const attempt = current?.state.attempts.find((entry) => entry.id === value.attemptId)
          // A closed attempt means this handoff was already sent (a retry gets its receipt) or cannot be:
          // either way the server's answer to the command is the useful one, so skip the uploads.
          if (current && attempt?.status === 'running') {
            if (current.version !== value.expectedVersion) throw new Error('Stale flow version')
            const upload = deps.apiPostForm ?? apiPostForm
            // Uploads land before the command, so a review gate opens with its files present.
            for (const file of await readAttachments(options.attach)) {
              const form = new FormData()
              form.set('file', new File([file.bytes], basename(file.path)))
              form.set('path', file.path)
              await upload(
                `/api/workflows/runs/${encodeURIComponent(id)}/attempts/${value.attemptId}/attachments`,
                form
              )
            }
          }
        }
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
