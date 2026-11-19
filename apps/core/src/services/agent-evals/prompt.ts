import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import * as yaml from 'js-yaml'
import type { AgentScenario } from './define'
import type { PromptVariant } from './variant'
import { importFromVariant } from './variant'

/*
 * Assembles the system prompt a live agent of the scenario's type would receive, from a variant's
 * files: the agent type and its includes from config/, and the runner sections (workspace, slot
 * pools, CLI index, workflow contract and delivery, memory, purpose) from the variant's own prompt
 * modules. Squad data comes from the fixture below instead of a database.
 *
 * Not included: the skills list and the tool descriptions the agent runtime adds (tool
 * descriptions are sent separately, see tools.ts), connected squads, schedules, and the manager's
 * Platform URLs section (instance addresses read from settings).
 */

/** Agent types run by the squad manager runner; every other squad type is a squad worker. */
const MANAGER_RUNNER_TYPES = new Set(['manager', 'consultant'])

export const FIXTURE_SQUAD = {
  id: '4ea8b934-a90a-42d1-b6fe-483a2ab9a18b',
  name: 'Ficus',
  purpose: 'Build and maintain the Ficus platform.',
  defaultAgents: ['engineer', 'reviewer'],
  managerAgentId: 'b4b8dd88-0d6f-4c37-9a0e-5d1e0f6a2c11',
  managerName: 'Cascade',
  agentId: '5ed28b9f-aa3a-4f1e-b1bc-627a02fa5086',
  sandboxId: 'box_c32089fe34ce',
  workspaceRoot: '/workspace/4ea8b934-a90a-42d1-b6fe-483a2ab9a18b',
  context: [
    'Ficus squad: engineers and reviewers working on the ficushq/ficus repository (Core, CLI and web app).',
    'Every agent shares one squad box with a few CPUs. Run focused tests only; CI runs the full suite.',
    'Noah (GitHub noahsaso) owns the repository and merges pull requests unless the flow says otherwise.',
  ].join('\n\n'),
  memoryMap: [
    '# Memory Map',
    '',
    '- `decisions/`: architecture and product decisions with rationale',
    '- `patterns/`: code conventions for this repository',
    '- `debugging/`: playbooks for common errors',
    '- `runbooks/`: operational checklists',
  ].join('\n'),
}

interface AgentTypeFile {
  id: string
  name: string
  tier?: string
  includes?: string[]
  systemPrompt: string
  tools?: { allow?: string[]; deny?: string[] }
}

export function readAgentType(root: string, id: string): AgentTypeFile {
  const path = join(root, 'config/agent-types', `${id}.yaml`)
  if (!existsSync(path)) throw new Error(`No built-in agent type '${id}' in ${root}`)
  return yaml.load(readFileSync(path, 'utf8')) as AgentTypeFile
}

/** The type's prompt and its includes, joined like compose-prompt.ts does at runtime. */
export function composeStaticPrompt(root: string, type: AgentTypeFile): string {
  const parts = [type.systemPrompt]
  for (const id of type.includes ?? []) {
    const path = join(root, 'config/agent-types/shared', `${id}.md`)
    if (existsSync(path)) parts.push(readFileSync(path, 'utf8'))
  }
  return parts.join('\n\n')
}

const importFrom = importFromVariant

const src = (path: string) => join('apps/core/src', path)

/** Permissions of a built-in agent role (config/roles/defaults.yaml), for the CLI index. */
export function rolePermissions(root: string, slug: string): string[] {
  const roles = yaml.load(readFileSync(join(root, 'config/roles/defaults.yaml'), 'utf8')) as {
    roles: { slug: string; permissions?: string[] }[]
  }
  return roles.roles.find((role) => role.slug === slug)?.permissions ?? []
}

/** The CLI index the agent sees, built from the variant's own CLI program and index renderer. */
async function cliIndex(variant: PromptVariant, permissions: readonly string[]): Promise<string> {
  const { createProgram } = await importFrom<{ createProgram: () => { helpInformation: () => string } }>(
    variant,
    'apps/cli/src/program.ts'
  )
  const help = await importFrom<typeof import('../../lib/utils/cli-help')>(variant, src('lib/utils/cli-help.ts'))
  // Squad runners leave out the host-only groups; a variant from before that option ignores it.
  return help.renderCliCommandIndex(help.parseCommandGroups(createProgram().helpInformation()), permissions, {
    omitHostGroups: true,
  })
}

/**
 * Built-in public-capable types opt in through public-text. Read this ref's shipped default,
 * not live settings or the working tree's newer profile. A pre-voice ref stays voice-free,
 * even when its squad assembler falls back to the working tree's implementation.
 */
async function defaultPublicVoice(variant: PromptVariant, type: AgentTypeFile) {
  const profilePath = join(variant.root, 'config/public-voices/default.yaml')
  const rulesPath = join(variant.root, 'config/agent-types/shared/public-text.md')
  const voicePath = 'packages/shared/src/public-voice.ts'
  if (
    !type.includes?.includes('public-text') ||
    !existsSync(rulesPath) ||
    !existsSync(profilePath) ||
    !existsSync(join(variant.root, voicePath))
  )
    return undefined

  // Import the pure shared module directly: no entities, config sync or database loaders.
  const voice = await importFrom<typeof import('@ficus/shared')>(variant, voicePath)
  const profile = voice.publicVoiceProfileInputSchema.parse(yaml.load(readFileSync(profilePath, 'utf8')))
  const resolved = voice.resolvePublicVoice({
    squad: null,
    assigned: null,
    instanceDefault: {
      ...profile,
      description: profile.description ?? null,
      surfaces: profile.surfaces ?? {},
      disabled: false,
    },
  })
  return {
    section: voice.renderPublicVoicePrompt(voice.fitPublicVoiceToCap(resolved, voice.PUBLIC_VOICE_MAX_BYTES).resolved),
    publicTextEnabled: true,
  }
}

export interface AssembledPrompt {
  systemPrompt: string
  agentType: AgentTypeFile
}

export async function assembleScenarioPrompt(
  variant: PromptVariant,
  scenario: AgentScenario
): Promise<AssembledPrompt> {
  const { root } = variant
  const type = readAgentType(root, scenario.agentType)
  const typePrompt = composeStaticPrompt(root, type)
  const publicVoice = await defaultPublicVoice(variant, type)
  const assembler = await importFrom<typeof import('../../lib/prompts/squad-agent-prompt')>(
    variant,
    src('lib/prompts/squad-agent-prompt.ts')
  )
  // The pure renderer, or for a variant from before it was split out, the module that held it.
  const renderPath = existsSync(join(root, src('lib/prompts/slot-pools-render.ts')))
    ? src('lib/prompts/slot-pools-render.ts')
    : src('lib/prompts/slot-pools-prompt.ts')
  const slots = await importFrom<typeof import('../../lib/prompts/slot-pools-render')>(variant, renderPath)
  const workspacePrompt = await importFrom<typeof import('../../lib/prompts/workspace-prompt')>(
    variant,
    src('lib/prompts/workspace-prompt.ts')
  )

  const slotPools = slots.renderSlotPoolsPrompt(
    (scenario.slotPools ?? []).map((pool) => ({
      key: pool.key,
      capacity: pool.capacity,
      claimTimeoutMs: pool.claimTimeoutMs,
      usage: pool.usage ?? null,
      ...(pool.hostCapacity !== undefined ? { hostCapacity: pool.hostCapacity } : {}),
    }))
  )
  const isManagerRunner = MANAGER_RUNNER_TYPES.has(type.id)
  const workspace = workspacePrompt.buildWorkspacePrompt({
    ...(isManagerRunner ? { agentId: FIXTURE_SQUAD.agentId } : {}),
    squadId: FIXTURE_SQUAD.id,
    squadName: FIXTURE_SQUAD.name,
    sandboxId: FIXTURE_SQUAD.sandboxId,
    hasSquadBash: true,
    toolNames: workspacePrompt.workspaceToolNamesForPolicy(type.tools?.allow, type.tools?.deny, true),
    mayShareWithSubagents: true,
  })
  const identity = {
    agent: { id: FIXTURE_SQUAD.agentId, typeId: type.id, typeName: type.name },
    squad: {
      id: FIXTURE_SQUAD.id,
      name: FIXTURE_SQUAD.name,
      purpose: FIXTURE_SQUAD.purpose,
      defaultAgents: FIXTURE_SQUAD.defaultAgents,
      context: scenario.squadContext ?? FIXTURE_SQUAD.context,
      managerAgentId: FIXTURE_SQUAD.managerAgentId,
      workspaceRoot: FIXTURE_SQUAD.workspaceRoot,
    },
  }
  const memory = { map: FIXTURE_SQUAD.memoryMap }

  if (isManagerRunner) {
    const overridesPath = src('lib/prompts/model-overrides-prompt.ts')
    const modelOverrides = existsSync(join(root, overridesPath))
      ? (
          await importFrom<{ buildModelOverridePrompt: () => string }>(variant, overridesPath)
        ).buildModelOverridePrompt()
      : ''
    return {
      agentType: type,
      systemPrompt: assembler.assembleSquadManagerPrompt({
        ...identity,
        typePrompt,
        slotPools,
        publicVoice,
        workspace,
        cliHelp: await cliIndex(variant, ['*']),
        modelOverrides,
        squadState: '',
        workflow: { preset: 'reviewed-coding' },
        workflowSetup: null,
        typeContext: '',
        memory,
        isConsultant: type.id === 'consultant',
        externalChannel: false,
        // The instance's own addresses (read from settings, so from the database); not guidance.
        platformUrls: '',
      }),
    }
  }

  return {
    agentType: type,
    systemPrompt: assembler.assembleSquadWorkerPrompt({
      ...identity,
      typePrompt,
      slotPools,
      publicVoice,
      workspace,
      teammates: `## Squad Manager Agent\n- ${FIXTURE_SQUAD.managerName} (manager) [${FIXTURE_SQUAD.managerAgentId.slice(0, 8)}] — Manager`,
      cliHelp: await cliIndex(variant, rolePermissions(root, 'default-worker')),
      activeSchedules: '',
      flow: scenario.flow
        ? {
            participantId: type.id,
            workStreamId: scenario.flow.workStreamId,
            deliveryInstructions: scenario.flow.deliveryMode
              ? (
                  await importFrom<typeof import('../workflows/completion-prompt')>(
                    variant,
                    src('services/workflows/completion-prompt.ts')
                  )
                ).flowCompletionInstructions(scenario.flow.deliveryMode)
              : null,
          }
        : null,
      typeContext: '',
      memory,
    }),
  }
}
