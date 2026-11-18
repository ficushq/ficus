import { prompt, interpolateTemplate } from './prompt-builder'
import { slotPoolsPromptFallback } from './slot-pools-render'
import { buildMemorySystemPrompt, MANAGER_MEMORY_GUIDANCE } from './memory-prompt'
import { AGENT_PURPOSE_DISPLAY_SECTION_TITLE, SET_AGENT_PURPOSE_INSTRUCTIONS } from './agent-purpose-prompt'

/*
 * How a squad agent's system prompt is put together from parts the runner has already fetched
 * (the composed agent-type prompt, the CLI index, the slot pools, the flow assignment and so on).
 * Kept free of database reads so the agent behaviour evals (services/agent-evals) assemble exactly
 * the prompt a live squad worker or manager receives, from fixtures and from an older checkout.
 */

/** The squad-rules section that already explains advancing, waits and delivery. */
export const FLOW_RULES_SECTION_HEADING = '## Work Streams, Handoffs, and Reviews'

/** How a flow worker advances, waits and delivers, for agent types that do not include squad-rules. */
export const FLOW_CONTRACT_RULES =
  'Submit outcomes with ficus workstream advance --content using single-quoted JSON for short commands, or --stdin with a quoted heredoc for longer JSON/YAML; no temporary file is needed. The command must contain action, expectedVersion, attemptId, outcome, and evidence as a string. Re-read after a version conflict; retry only if your attempt is still running. A completed attempt changes only through action amend, and only while the human approval gate it feeds is open. Never bypass flow gates with assignee/status changes or untracked agents. While paused or blocked by an open wait, end your turn without scheduling a continuation; an answer is not approval. At completion-ready, final delivery review permits code-host feedback triage and tracked rework as described in deliveryInstructions. Parallel agents share the workspace, so coordinate file ownership. After advancing, workStreamStatus=done means delivery is complete: end your turn. Otherwise continue assignments returned to you in the command response without waiting for an inbox notification. Follow deliveryInstructions from the response or run when completion-ready; if only another agent has work, end your turn.'

/** Identity and squad values shared by the worker and manager prompts. */
export interface SquadAgentPromptIdentity {
  agent: { id: string; typeId: string; typeName: string }
  squad: {
    id: string
    name: string
    purpose: string
    defaultAgents: string[]
    context: string | null
    managerAgentId: string | null
    /** The squad's namespaced shared-workspace root, for {{workspaceRoot}}. */
    workspaceRoot: string
  }
}

export interface SquadWorkerPromptParts extends SquadAgentPromptIdentity {
  /** The agent type's prompt with its includes (compose-prompt.ts). */
  typePrompt: string
  /** The generated Slot Pools section, or '' when the squad has none. */
  slotPools: string
  /** The rendered workspace section (workspace-prompt.ts). */
  workspace: string
  /** The `## Squad Manager Agent` roster line, or ''. */
  teammates: string
  cliHelp: string
  activeSchedules: string
  /** The flow assignment, when the worker participates in one. */
  flow: { participantId: string; workStreamId: string; deliveryInstructions?: string | null } | null
  /** Squad-owned context for this agent type, or ''. */
  typeContext: string
  /** Set when squad memory is enabled, with the vault's map.md when it exists; otherwise null. */
  memory: { map: string | undefined } | null
}

function identityValues({ agent, squad }: SquadAgentPromptIdentity): Record<string, string> {
  return {
    'agent.id': agent.id,
    'agent.typeName': agent.typeName,
    'agent.typeId': agent.typeId,
    'squad.id': squad.id,
    'squad.name': squad.name,
    'squad.purpose': squad.purpose,
    'squad.defaultAgents': squad.defaultAgents.join(', ') || 'none',
    'squad.context': squad.context ?? '',
    'manager.id': squad.managerAgentId ?? '',
    workspaceRoot: squad.workspaceRoot,
  }
}

/** The system prompt of a squad worker (any squad agent that is not its manager or a consultant). */
export function assembleSquadWorkerPrompt(parts: SquadWorkerPromptParts): string {
  const { typePrompt, flow } = parts
  const p = prompt().text(typePrompt).text(slotPoolsPromptFallback(typePrompt, parts.slotPools)).text(parts.workspace)

  if (flow) {
    // squad-rules teaches how to advance, wait and deliver. Repeat it here only when the
    // composed prompt lacks that section (a custom type, or a disabled or rewritten
    // include), so no flow worker reads it twice.
    const flowRules = typePrompt.includes(FLOW_RULES_SECTION_HEADING)
      ? 'Submit outcomes with ficus workstream advance as described under Work Streams, Handoffs, and Reviews.'
      : FLOW_CONTRACT_RULES
    p.section(
      'Workflow contract',
      `You are participant ${flow.participantId} in work stream ${flow.workStreamId}. Follow your active step and return requests from the inbox; use ficus workstream flow ${flow.workStreamId} to check current state. ${flowRules}`
    )
    if (flow.deliveryInstructions) p.section('Workflow delivery', flow.deliveryInstructions)
  }

  // Type-specific context: additive to the global squad context.
  if (parts.typeContext) p.section('Type-Specific Context', parts.typeContext)
  if (parts.memory) p.text(buildMemorySystemPrompt(parts.squad.id, parts.memory.map))
  p.section(AGENT_PURPOSE_DISPLAY_SECTION_TITLE, SET_AGENT_PURPOSE_INSTRUCTIONS)

  return interpolateTemplate(p.build(), {
    ...identityValues(parts),
    // The workspace section is added directly above so every worker type gets it even if
    // its agent type omits squad-rules.md (which carries the {{workspace}} placeholder);
    // empty here avoids a second copy when squad-rules IS included.
    workspace: '',
    teammates: parts.teammates,
    cliHelp: parts.cliHelp,
    activeSchedules: parts.activeSchedules,
    // Generated from the live pool registry, right after the squad context.
    'squad.slotPools': parts.slotPools,
  })
}

export interface SquadManagerPromptParts extends SquadAgentPromptIdentity {
  typePrompt: string
  slotPools: string
  workspace: string
  cliHelp: string
  modelOverrides: string
  /** Connected squads and active schedules, for the Current Squad State section. */
  squadState: string
  /** The squad's default workflow and setup guidance (squad metadata), or null. */
  workflow: unknown
  workflowSetup: unknown
  /** Squad-owned context for the manager type, or ''. */
  typeContext: string
  memory: { map: string | undefined } | null
  /** Consultants share this runner; they also set a display purpose. */
  isConsultant: boolean
  /** Set for a consultant that speaks through an external channel. */
  externalChannel: boolean
  platformUrls: string
}

/** The system prompt of a squad manager or consultant. */
export function assembleSquadManagerPrompt(parts: SquadManagerPromptParts): string {
  const { typePrompt } = parts
  const p = prompt()
    .text(typePrompt)
    .text(slotPoolsPromptFallback(typePrompt, parts.slotPools))
    .text(parts.workspace)
    .section('Model Overrides', parts.modelOverrides)
    .section('Current Squad State', parts.squadState)

  p.section(
    'Declarative workflows',
    `The effective squad default workflow is: ${JSON.stringify(parts.workflow ?? null)}. Guided flows follow declared paths; flexible flows allow bounded rework and tracked specialist delegation; adaptive flows support authorized future-step revisions. Preserve required checks unless explicitly authorized to change policy.`
  )
  p.section(
    'Workflow setup',
    `Current selection guidance: ${JSON.stringify(parts.workflowSetup ?? null)}. Consult setup-workflows during the first user-led setup conversation or when the user asks to change how this squad works. Use existing preferences; do not repeat completed onboarding or start agents to configure flows. Selection guidance is advice, not an automatic classifier: choose the appropriate explicit source when creating work.`
  )

  if (parts.typeContext) p.section('Type-Specific Context', parts.typeContext)

  if (parts.memory) {
    p.text(buildMemorySystemPrompt(parts.squad.id, parts.memory.map))
    if (parts.agent.typeId === 'manager') p.text(MANAGER_MEMORY_GUIDANCE)
  }

  // Consultants set a dynamic display purpose like squad workers do. The manager keeps a static identity.
  if (parts.isConsultant) p.section(AGENT_PURPOSE_DISPLAY_SECTION_TITLE, SET_AGENT_PURPOSE_INSTRUCTIONS)

  if (parts.externalChannel) {
    p.section(
      'External channel conversation',
      [
        'You are a consultant speaking through an external channel. Incoming requests have passed the channel’s linked-user or trusted-channel access policy. Reply in the originating channel; users are responsible for choosing an appropriate audience.',
        'Use channel_respond once/early for each inbound inbox message. It replaces the thinking placeholder and marks the message read. Ask clarification questions there, not through ask_human.',
        'Use channel_send for later progress and final results. Use channel_edit only for Ficus-sent message IDs returned by these tools.',
        'For work requested here, create a work stream owned by you so its lifecycle updates return to this conversation. Coordinate operational decisions with the squad manager, and relay progress back through channel_send.',
      ].join('\n')
    )
  }
  p.text(parts.platformUrls)

  // The manager type includes squad-rules.md, which carries the worker placeholders
  // ({{workspace}}, {{teammates}}, {{activeSchedules}}). The manager supplies those through
  // its own sections above (the workspace section, and Current Squad State with the active
  // schedules), so they resolve to empty here. The CLI index is emitted only through
  // {{cliHelp}}, so it carries the real value.
  return interpolateTemplate(p.build(), {
    ...identityValues(parts),
    'squad.slotPools': parts.slotPools,
    workspace: '',
    teammates: '',
    activeSchedules: '',
    cliHelp: parts.cliHelp,
  })
}
