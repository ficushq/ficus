import {
  addStructuredInputOptions,
  readStructuredInput,
  validateStructuredInput,
  type StructuredInputOptions,
} from '../structured-input'
import { readFile, stat } from 'node:fs/promises'
import { basename } from 'node:path'
import { Command } from 'commander'
import {
  WORKFLOW_ATTEMPT_ATTACHMENT_LIMIT,
  workflowCommandSchema,
  validateWorkflowDecisionBrief,
  type WorkflowRun,
  type WorkStreamAssetSource,
} from '@ficus/shared'
import { apiGet, apiPost, apiPostForm } from '../client'
import { output, outputError } from '../output'

const defaults = { apiGet, apiPost, output, outputError }
export type WorkstreamFlowDependencies = typeof defaults & { apiPostForm?: typeof apiPostForm }

/** Core's default per-file cap (INBOX_MAX_ATTACHMENT_BYTES); the server enforces its configured value. */
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024

/** The part of `workstream flow` that decides whether attaching still makes sense. */
type FlowSnapshot = { version: number; state: WorkflowRun }

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
    .option(
      '--attach-image <imageId>',
      'Attach a chat image Ficus already stores, by ID, with no copy (repeatable; complete only)',
      collect,
      []
    )
    .option(
      '--attach-agent-file <attachmentId>',
      'Attach a chat file Ficus already stores, by ID, with no copy (repeatable; complete only)',
      collect,
      []
    )
    .addHelpText(
      'after',
      '\nThe command must include action, expectedVersion, attemptId, and action-specific fields (e.g. outcome and evidence for complete).\nAuthorized revise active=keep refreshes outcomes for kept running attempts while preserving their initial brief and session. The response outcomeUpdates lists affected attempt/agent IDs; record scope and steer every affected active agent. Inspect activeOutcomes with workstream flow.\nUse active=restart only for deliberate cancellation and a new attempt with a fresh session, even with reuse-within-stream. Revised instructions apply to future attempts, not a kept initial brief.\nAgent-produced completions or explicit returns into human approval require decisionBrief: decision (500 characters), recommendation (1000), approvalEffect (2400), risks (1600), and changesSinceLastReview (2000, required after an earlier decision on the same gate). Each field must use readable prose with normal spacing and complete words; preserve literal identifiers. Briefs are optional on other handoffs; evidence or return feedback stays separate. Contextual preflight runs before attachments.\n--attach uploads each file to the completing attempt before the command is sent; --attach-image and --attach-agent-file attach stored chat images and files by ID instead of uploading. If any attachment fails, the attempt is not advanced.'
    )
    .action(
      (
        id: string,
        options: StructuredInputOptions & {
          requestId?: string
          attach: string[]
          attachImage?: string[]
          attachAgentFile?: string[]
        }
      ) =>
        run(async () => {
          const value = validateStructuredInput(workflowCommandSchema, await readStructuredInput(options))
          const references: WorkStreamAssetSource[] = [
            ...(options.attachImage ?? []).map((imageId) => ({ kind: 'image' as const, imageId })),
            ...(options.attachAgentFile ?? []).map((attachmentId) => ({ kind: 'agent-file' as const, attachmentId })),
          ]
          if (options.attach.length || references.length) {
            if (value.action !== 'complete')
              throw new Error(
                '--attach, --attach-image and --attach-agent-file are only available when completing an attempt'
              )
            if (options.attach.length + references.length > WORKFLOW_ATTEMPT_ATTACHMENT_LIMIT)
              throw new Error(`At most ${WORKFLOW_ATTEMPT_ATTACHMENT_LIMIT} files can be attached to one handoff`)
          }
          if (value.action === 'complete' || value.action === 'return') {
            const current = await deps.apiGet<FlowSnapshot | null>(`/api/workflows/runs/${encodeURIComponent(id)}`)
            const attempt = current?.state?.attempts.find((entry) => entry.id === value.attemptId)
            // A closed attempt means this handoff was already sent (a retry gets its receipt) or cannot be:
            // either way the server's answer to the command is the useful one, so skip the uploads.
            if (current && attempt?.status === 'running') {
              if (current.version !== value.expectedVersion) throw new Error('Stale flow version')
              if (current.state.definition) validateWorkflowDecisionBrief(current.state, value)
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
              // Stored chat images and files are attached by ID: nothing is downloaded or uploaded.
              for (const source of references)
                await deps.apiPost(
                  `/api/workflows/runs/${encodeURIComponent(id)}/attempts/${value.attemptId}/asset-attachments`,
                  { source }
                )
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
