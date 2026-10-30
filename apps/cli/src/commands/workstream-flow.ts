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
  advanceWorkflowRun,
  workflowAmendEligibility,
  workflowCommandSchema,
  workflowAttemptLimitPause,
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
  /** Upload each file to the attempt (an amend stages them for its next revision). */
  async function uploadAttachments(id: string, attemptId: number, paths: string[]) {
    const upload = deps.apiPostForm ?? apiPostForm
    for (const file of await readAttachments(paths)) {
      const form = new FormData()
      form.set('file', new File([file.bytes], basename(file.path)))
      form.set('path', file.path)
      await upload(`/api/workflows/runs/${encodeURIComponent(id)}/attempts/${attemptId}/attachments`, form)
    }
  }
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
    .description('Complete, return, amend, delegate, rework, revise, or raise-limit a flow using a versioned command')
    .option('--request-id <id>', 'Stable UUID for retrying this exact command')
    .option(
      '--attach <path>',
      `Attach a file to the handoff for reviewers (repeatable; complete and amend only; at most ${WORKFLOW_ATTEMPT_ATTACHMENT_LIMIT} files of 10 MB)`,
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
      '\nThe command must include action, expectedVersion, attemptId, and action-specific fields (e.g. outcome and evidence for complete). When no attempt is active (for example a flow paused at its attempt limit), revise takes no attemptId: omit it or send null.\nAt an attempt-limit pause, {"action":"raise-limit","expectedVersion":N,"maxStepAttempts":<number or null>} raises or removes the limit and starts the held attempt in one step (see workstream raise-limit).\nAuthorized revise active=keep refreshes outcomes for kept running attempts while preserving their initial brief and session. The response outcomeUpdates lists affected attempt/agent IDs; record scope and steer every affected active agent. Inspect activeOutcomes with workstream flow.\nUse active=restart only for deliberate cancellation and a new attempt with a fresh session, even with reuse-within-stream. Revised instructions apply to future attempts, not a kept initial brief.\nAgent-produced completions or explicit returns into human approval require decisionBrief: decision (500 characters), recommendation (1000), approvalEffect (2400), risks (1600), and changesSinceLastReview (2000, required after an earlier decision on the same gate). Each field must use readable prose with normal spacing and complete words; preserve literal identifiers. Briefs are optional on other handoffs; evidence or return feedback stays separate. Contextual preflight runs before attachments.\n--attach uploads each file to the completing attempt before the command is sent; --attach-image and --attach-agent-file attach stored chat images and files by ID instead of uploading. If any attachment fails, the attempt is not advanced.\namend revises your own completed attempt while the human approval gate it feeds is open: send expectedVersion, attemptId, the complete revised decisionBrief and evidence (name the commit SHAs of any changes), optional removeAttachmentPaths, and --attach for files to add or replace (the CLI names them in attachmentPaths); other files and stored references carry over. Stored references are attached only when completing. The gate stays open and it is not a new review round. A decision on an older revision is refused.'
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
          const parsed = validateStructuredInput(workflowCommandSchema, await readStructuredInput(options))
          // An amend publishes only the files it names; the files attached here are named for it.
          const value =
            parsed.action === 'amend' && options.attach.length
              ? { ...parsed, attachmentPaths: [...new Set([...(parsed.attachmentPaths ?? []), ...options.attach])] }
              : parsed
          const references: WorkStreamAssetSource[] = [
            ...(options.attachImage ?? []).map((imageId) => ({ kind: 'image' as const, imageId })),
            ...(options.attachAgentFile ?? []).map((attachmentId) => ({ kind: 'agent-file' as const, attachmentId })),
          ]
          if (options.attach.length && value.action !== 'complete' && value.action !== 'amend')
            throw new Error('--attach is only available when completing or amending an attempt')
          // Stored references are not revisioned, so they attach only to a running attempt.
          if (references.length && value.action !== 'complete') {
            const flags = [
              options.attachImage?.length ? '--attach-image' : '',
              options.attachAgentFile?.length ? '--attach-agent-file' : '',
            ].filter(Boolean)
            throw new Error(
              `${flags.join(' and ')} ${flags.length > 1 ? 'are' : 'is'} only available when completing an attempt`
            )
          }
          if (options.attach.length + references.length > WORKFLOW_ATTEMPT_ATTACHMENT_LIMIT)
            throw new Error(`At most ${WORKFLOW_ATTEMPT_ATTACHMENT_LIMIT} files can be attached to one handoff`)
          if (value.action === 'complete' || value.action === 'return') {
            const current = await deps.apiGet<FlowSnapshot | null>(`/api/workflows/runs/${encodeURIComponent(id)}`)
            const attempt = current?.state?.attempts.find((entry) => entry.id === value.attemptId)
            // A closed attempt means this handoff was already sent (a retry gets its receipt) or cannot be:
            // either way the server's answer to the command is the useful one, so skip the uploads.
            if (current && attempt?.status === 'running') {
              if (current.version !== value.expectedVersion) throw new Error('Stale flow version')
              if (current.state.definition) validateWorkflowDecisionBrief(current.state, value)
              // Uploads land before the command, so a review gate opens with its files present.
              await uploadAttachments(id, value.attemptId, options.attach)
              // Stored chat images and files are attached by ID: nothing is downloaded or uploaded.
              for (const source of references)
                await deps.apiPost(
                  `/api/workflows/runs/${encodeURIComponent(id)}/attempts/${value.attemptId}/asset-attachments`,
                  { source }
                )
            }
          }
          if (value.action === 'amend') {
            const current = await deps.apiGet<FlowSnapshot | null>(`/api/workflows/runs/${encodeURIComponent(id)}`)
            // An attempt that can no longer be amended (a retry of a landed amend, or a decided gate)
            // stages nothing; the server's answer to the command is the useful one.
            if (current?.state?.definition && workflowAmendEligibility(current.state, value.attemptId).ok) {
              if (current.version !== value.expectedVersion) throw new Error('Stale flow version')
              // The same validation the server runs, before any file is staged.
              advanceWorkflowRun(current.state, value)
              await uploadAttachments(id, value.attemptId, options.attach)
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
    .command('raise-limit <id>', { hidden: legacy })
    .description(
      'Unblock a flow paused at its attempt limit: raise or remove the attempts-per-step limit and start the held attempt'
    )
    .option(
      '--max-step-attempts <number>',
      'New attempts-per-step limit, above the attempts already used (at most 100)'
    )
    .option('--remove', 'Remove the attempt limit entirely')
    .option('-m, --reason <text>', 'Why, recorded with your name in the flow revision history')
    .option('--version <version>', 'Expected flow version (defaults to the current version from workstream flow)')
    .option('--request-id <id>', 'Stable UUID for retrying this exact command')
    .addHelpText(
      'after',
      '\nWorks only while the flow is paused at its attempt limit (workstream flow shows status paused and pauseReason attempt-limit). It clears the pause wait and starts the held attempt with its pending request in one step.\nAllowed: people who can review the work stream (an assigned reviewer when reviewers are assigned) or manage flows, the stream owner agent, and the squad manager agent. The agent that ran the paused step cannot raise its own limit.\nEquivalent advance command: {"action":"raise-limit","expectedVersion":<version>,"maxStepAttempts":<number or null>}.'
    )
    .action(
      (
        id: string,
        options: { maxStepAttempts?: string; remove?: boolean; reason?: string; version?: string; requestId?: string }
      ) =>
        run(async () => {
          if (!!options.remove === (options.maxStepAttempts !== undefined))
            throw new Error('Pass exactly one of --max-step-attempts <number> or --remove')
          const maxStepAttempts = options.remove ? null : Number(options.maxStepAttempts)
          if (maxStepAttempts !== null && (!Number.isSafeInteger(maxStepAttempts) || maxStepAttempts < 1))
            throw new Error('--max-step-attempts must be a positive whole number')
          const current = await deps.apiGet<FlowSnapshot | null>(`/api/workflows/runs/${encodeURIComponent(id)}`)
          if (!current) throw new Error('This work stream has no flow')
          const pause = workflowAttemptLimitPause(current.state)
          if (!pause)
            throw new Error(
              `The flow is ${current.state.status}, not paused at an attempt limit; there is no limit to raise`
            )
          const expectedVersion = options.version === undefined ? current.version : Number(options.version)
          if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0)
            throw new Error('Version must be a nonnegative integer')
          const value = workflowCommandSchema.parse({
            action: 'raise-limit',
            expectedVersion,
            maxStepAttempts,
            ...(options.reason ? { reason: options.reason } : {}),
          })
          deps.output(
            await deps.apiPost(`/api/workflows/runs/${encodeURIComponent(id)}/advance`, {
              command: value,
              requestId: options.requestId ?? crypto.randomUUID(),
            }),
            maxStepAttempts === null
              ? `Removed the attempt limit for step ${pause.stepId}; its next attempt is starting`
              : `Raised the attempt limit for step ${pause.stepId} to ${maxStepAttempts}; its next attempt is starting`
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
