import { join } from 'node:path'
import type { Command, Help } from 'commander'
import { permissionMatches } from '@ficus/shared'
import { CLI_COMMAND_PERMISSIONS } from '../../lib/utils/cli-help'
import { executedCommands } from './shell-commands'
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
import { FIXTURE_SQUAD, rolePermissions } from './prompt'

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

/**
 * Capture the real Commander help, including before/after hooks, without parsing argv or exiting.
 * Only executable help requests count. Filter visible commands with the index permission map.
 * Restore help configuration and output callbacks even when a listener throws; the tree stays untouched.
 */
export function cliHelpFor(
  program: Command,
  source: string,
  permissions: readonly string[] = ['*'],
  requiredPermissions: Readonly<Record<string, readonly string[]>> = CLI_COMMAND_PERMISSIONS
): string | undefined {
  const mayUse = (path: string[]) => {
    if (path[0] === 'secret') return false
    const required = requiredPermissions[path.join(' ')]
    return !required || required.some((needed) => permissions.some((held) => permissionMatches(held, needed)))
  }
  const outputs: string[] = []
  for (const argv of executedCommands(source)) {
    if (argv[0] !== 'ficus') continue
    const words = argv.slice(1).filter((word) => !/^\d?>/.test(word))
    if (!words.includes('--help') && !words.includes('-h') && words[0] !== 'help') continue
    let current = program
    const path: string[] = []
    let valid = true
    for (let index = 0; index < words.length; index++) {
      const word = words[index]!
      if (word.startsWith('-')) {
        const option = [...current.options, ...program.options].find(
          (option) => option.long === word || option.short === word
        )
        if (
          (option?.required || option?.optional) &&
          !word.includes('=') &&
          words[index + 1] &&
          !words[index + 1]!.startsWith('-')
        )
          index++
        continue
      }
      if (word === 'help') continue
      const next = current.commands.find((child) => child.name() === word || child.aliases().includes(word))
      if (!next) {
        if (current.registeredArguments.length > 0) continue
        valid = false
        break
      }
      path.push(next.name())
      if (!mayUse(path)) {
        valid = false
        break
      }
      current = next
    }
    if (!valid) continue
    const originalOutput = { ...current.configureOutput() }
    const originalHelp = current.configureHelp()
    const originalVisibleCommands = current.createHelp().visibleCommands
    let output = ''
    try {
      current.configureHelp({
        ...originalHelp,
        visibleCommands(this: Help, command: Command) {
          return originalVisibleCommands.call(this, command).filter((child) => mayUse([...path, child.name()]))
        },
      })
      current.configureOutput({
        writeOut: (text) => {
          output += text
        },
        writeErr: (text) => {
          output += text
        },
      })
      current.outputHelp()
      outputs.push(output)
    } finally {
      current.configureOutput(originalOutput)
      current.configureHelp(originalHelp)
    }
  }
  return outputs.length ? outputs.join('\n') : undefined
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
  if (/^git status(?: --short)?$/.test(command.trim())) return ''
  return 'Unsupported eval command: no fixture response is declared. This is not a successful command result.'
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
  const { createProgram } = await importFrom<{ createProgram: () => Command }>(variant, 'apps/cli/src/program.ts')
  const program = createProgram()
  const context = variantContext(variant)
  const permissions = options.managerRunner ? ['*'] : rolePermissions(variant.root, 'default-worker')
  const helpModule = await importFrom<typeof import('../../lib/utils/cli-help')>(variant, src('lib/utils/cli-help.ts'))

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
      const help =
        command === undefined
          ? undefined
          : cliHelpFor(program, command, permissions, helpModule.CLI_COMMAND_PERMISSIONS)
      if (scripted !== undefined || help !== undefined)
        return [scripted, help].filter((value) => value !== undefined).join('\n')
      if (name === 'ask_human') {
        const result = await askHumanTool.execute!('eval-call', args)
        return result.content.map((part) => part.text ?? '').join('')
      }
      if (command !== undefined) return defaultShellResult(command)
      return defaultResult(name, args)
    },
  }
}
