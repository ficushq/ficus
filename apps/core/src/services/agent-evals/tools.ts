import { join } from 'node:path'
import type { Tool } from '@earendil-works/pi-ai'
import {
  createBashToolDefinition,
  createEditToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
} from '@earendil-works/pi-coding-agent'
import type { Responder } from './define'
import type { PromptVariant } from './variant'
import { importFromVariant, variantContext } from './variant'
import { FIXTURE_SQUAD } from './prompt'

/*
 * The tools an eval agent sees: the real names, descriptions and parameter schemas of the
 * variant's tools (so guidance moved into a tool description is compared too), with stub
 * execution. ask_human runs its real code with a fake question store, so the agent reads the
 * variant's own result text.
 */

interface ToolDefinitionLike {
  name: string
  description: string
  parameters: unknown
  execute?: (toolCallId: string, params: any) => Promise<{ content: { type: string; text?: string }[] }>
}

export interface EvalToolset {
  tools: Tool[]
  /** The stub result for a call, after the scenario's responder had its chance. */
  execute: (name: string, args: Record<string, unknown>) => Promise<string>
}

const importFrom = importFromVariant

const src = (path: string) => join('apps/core/src', path)

/** Splits a shell word list well enough for `ficus ... --help` lines (quotes, no expansions). */
function shellWords(text: string): string[] {
  return [...text.matchAll(/'([^']*)'|"([^"]*)"|(\S+)/g)].map((match) => match[1] ?? match[2] ?? match[3] ?? '')
}

interface CommandLike {
  name(): string
  aliases(): string[]
  commands: CommandLike[]
  helpInformation(): string
}

/**
 * The variant CLI's real help for `ficus <group> [<command>] --help`, found by walking the command
 * tree (no parsing, so no process exit). Undefined when the line is not a help request.
 */
export function cliHelpFor(program: CommandLike, command: string): string | undefined {
  const segment = command
    .split(/&&|\|\||;|\|/)
    .find((part) => /\bficus\b/.test(part) && /(--help|-h\b|\bhelp\b)/.test(part))
  if (!segment) return undefined
  const words = shellWords(segment.slice(segment.search(/\bficus\b/) + 'ficus'.length))
  let current = program
  for (const word of words) {
    if (word.startsWith('-') || word === 'help') continue
    const next = current.commands.find((child) => child.name() === word || child.aliases().includes(word))
    if (!next) break
    current = next
  }
  return current.helpInformation()
}

/** Neutral results for calls the scenario does not script. */
function defaultResult(name: string, args: Record<string, unknown>): string {
  switch (name) {
    case 'read':
      return `(${String(args.path ?? 'file')}: contents not relevant to this scenario)`
    case 'write':
      return `Successfully wrote to ${String(args.path ?? 'the file')}`
    case 'edit':
      return `Successfully replaced text in ${String(args.path ?? 'the file')}.`
    case 'notify_contact':
      return `Notification sent to manager Cascade: "${String(args.title ?? '')}"`
    case 'set_agent_purpose':
      return `Agent purpose set to: ${String(args.purpose ?? '')}`
    default:
      return '(no output)'
  }
}

function defaultShellResult(command: string): string {
  if (/\bficus inbox read\b/.test(command)) return 'Marked 1 message(s) as read'
  if (/\bgit status\b/.test(command)) return ''
  return '(no output)'
}

export async function buildEvalToolset(
  variant: PromptVariant,
  options: { managerRunner: boolean; respond?: Responder }
): Promise<EvalToolset> {
  const askHuman = await importFrom<typeof import('../../tools/ask-human-async')>(
    variant,
    src('tools/ask-human-async.ts')
  )
  const notify = await importFrom<typeof import('../../tools/notify-contact')>(variant, src('tools/notify-contact.ts'))
  const purpose = await importFrom<typeof import('../../tools/agent-purpose')>(variant, src('tools/agent-purpose.ts'))
  const contract = await importFrom<typeof import('../../lib/bash-contract')>(variant, src('lib/bash-contract.ts'))
  const squadBash = await importFrom<{ buildSquadBashDescription?: (mount: string) => string }>(
    variant,
    src('tools/squad-bash.ts')
  )
  const { createProgram } = await importFrom<{ createProgram: () => CommandLike }>(variant, 'apps/cli/src/program.ts')
  const program = createProgram()
  const context = variantContext(variant)

  let questions = 0
  const askHumanTool = askHuman.createAsyncAskHumanTool(
    { agentId: FIXTURE_SQUAD.agentId, executionId: 'eval-execution', flushPersistence: async () => {} },
    {
      createQuestion: (async (_origin: unknown, _payload: unknown, opts: { blocking?: boolean }) => {
        questions += 1
        return {
          id: `7e33c9ef-0000-4000-8000-00000000000${questions}`,
          audienceResolution: 'routed',
          openedWaitWorkStreamIds: opts.blocking ? ['08a1ca4f-4143-4c05-af4c-58e8e30e870a'] : [],
        }
      }) as never,
    },
    { allowBlocking: !options.managerRunner }
  ) as unknown as ToolDefinitionLike

  const workspaceMount = '/home/box_e49af02f8b45/workspace'
  const bash = createBashToolDefinition('/home/box_c32089fe34ce/.private') as unknown as ToolDefinitionLike
  const bashDescription = `Execute a bash command in the current working directory. Returns stdout and stderr. ${contract.BASH_OUTPUT_TRUNCATION_NOTE} Optionally provide a timeout in seconds (default: 180s / 3 minutes, max: 3600s / 1 hour). ${contract.FOREGROUND_BASH_GUIDANCE} ${contract.LEFTOVER_PROCESS_GUIDANCE}`
  const squadBashDescription = squadBash.buildSquadBashDescription
    ? squadBash.buildSquadBashDescription(workspaceMount)
    : bashDescription

  const definitions: ToolDefinitionLike[] = [
    { name: 'bash', description: bashDescription, parameters: bash.parameters },
    { name: 'squad_bash', description: squadBashDescription, parameters: bash.parameters },
    createReadToolDefinition(workspaceMount) as unknown as ToolDefinitionLike,
    createWriteToolDefinition(workspaceMount) as unknown as ToolDefinitionLike,
    createEditToolDefinition(workspaceMount) as unknown as ToolDefinitionLike,
    askHumanTool,
    notify.createNotifyContactTool({ agentId: FIXTURE_SQUAD.agentId }) as unknown as ToolDefinitionLike,
    purpose.createSetAgentPurposeTool({ agentId: FIXTURE_SQUAD.agentId }) as unknown as ToolDefinitionLike,
  ]

  return {
    tools: definitions.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters as Tool['parameters'],
    })),
    async execute(name, args) {
      const command = name === 'bash' || name === 'squad_bash' ? String(args.command ?? '') : undefined
      const scripted = await options.respond?.({ name, args, ...(command !== undefined ? { command } : {}) }, context)
      if (scripted !== undefined) return scripted
      if (name === 'ask_human') {
        const result = await askHumanTool.execute!('eval-call', args)
        return result.content.map((part) => part.text ?? '').join('')
      }
      if (command !== undefined) return cliHelpFor(program, command) ?? defaultShellResult(command)
      return defaultResult(name, args)
    },
  }
}
