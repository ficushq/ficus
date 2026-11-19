import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import * as yaml from 'js-yaml'
import type { Message, Tool } from '@earendil-works/pi-ai'
import {
  DEFAULT_MAX_STEPS,
  type AgentScenario,
  type ScenarioText,
  type Trace,
  type TraceStep,
  type VariantContext,
  type Verdict,
} from './define'
import { assembleScenarioPrompt, readAgentType } from './prompt'
import { buildEvalToolset } from './tools'
import { variantContext, type PromptVariant } from './variant'

/** Longest tool result kept in a recording; the agent itself receives the full text. */
const RECORDED_RESULT_LIMIT = 2_000

/** The cheaper tier compared with each type's default (see docs/wiki/agent-behaviour-evals.md). */
export const CHEAPER_TIER = 'fast'

export interface ModelChoice {
  /** `provider:model[:level]` from config/model-tiers. */
  spec: string
  tier: string
}

/** One step of the model loop: given the conversation so far, the next assistant reply. */
export type AgentTurn = (input: {
  systemPrompt: string
  messages: Message[]
  tools: Tool[]
  model: ModelChoice
  signal?: AbortSignal
}) => Promise<{ text: string; calls: { id: string; name: string; args: Record<string, unknown> }[]; message: Message }>

export interface RecordedRun {
  scenario: string
  variant: string
  commit?: string
  model: string
  tier: string
  repeat: number
  promptSha256: string
  trace: Trace
  verdict: Verdict
}

export const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')

export function tierChain(root: string, tier: string): string[] {
  const file = yaml.load(readFileSync(join(root, 'config/model-tiers', `${tier}.yaml`), 'utf8')) as { chain: string }
  return file.chain.split(',').map((spec) => spec.trim())
}

/** The type's default tier and the cheaper one, as Noah asked; one entry when they coincide. */
export function tiersFor(root: string, agentType: string): string[] {
  const own = readAgentType(root, agentType).tier || 'standard'
  return own === CHEAPER_TIER ? [own] : [own, CHEAPER_TIER]
}

export async function runScenario(input: {
  scenario: AgentScenario
  variant: PromptVariant
  model: ModelChoice
  turn: AgentTurn
  repeat: number
  signal?: AbortSignal
}): Promise<RecordedRun> {
  const { scenario, variant, model, turn } = input
  const { systemPrompt, agentType } = await assembleScenarioPrompt(variant, scenario)
  const managerRunner = agentType.id === 'manager' || agentType.id === 'consultant'
  const toolset = await buildEvalToolset(variant, {
    managerRunner,
    respond: scenario.createResponder?.() ?? scenario.respond,
  })
  const context = variantContext(variant)
  const messages = await historyMessages(scenario, context, model)
  const opening = await Promise.all(scenario.messages.map((text) => resolveText(text, context)))
  messages.push({ role: 'user', content: opening.join('\n\n'), timestamp: Date.now() })
  const steps: TraceStep[] = []
  let ended = false

  for (let step = 0; step < (scenario.maxSteps ?? DEFAULT_MAX_STEPS); step++) {
    const reply = await turn({ systemPrompt, messages, tools: toolset.tools, model, signal: input.signal })
    messages.push(reply.message)
    const traceStep: TraceStep = { text: reply.text, calls: [] }
    steps.push(traceStep)
    if (reply.calls.length === 0) {
      ended = true
      break
    }
    for (const call of reply.calls) {
      const result = await toolset.execute(call.name, call.args)
      traceStep.calls.push({ name: call.name, args: call.args, result: result.slice(0, RECORDED_RESULT_LIMIT) })
      messages.push({
        role: 'toolResult',
        toolCallId: call.id,
        toolName: call.name,
        content: [{ type: 'text', text: result }],
        isError: false,
        timestamp: Date.now(),
      } as Message)
    }
  }

  const trace: Trace = { steps, ended }
  return {
    scenario: scenario.name,
    variant: variant.label,
    ...(variant.commit ? { commit: variant.commit } : {}),
    model: model.spec,
    tier: model.tier,
    repeat: input.repeat,
    promptSha256: sha256(systemPrompt),
    trace,
    verdict: scenario.grade(trace),
  }
}

export async function resolveText(text: ScenarioText, context: VariantContext): Promise<string> {
  return typeof text === 'string' ? text : await text(context)
}

/** The scenario's earlier conversation as provider-neutral messages. */
async function historyMessages(
  scenario: AgentScenario,
  context: VariantContext,
  model: ModelChoice
): Promise<Message[]> {
  const [provider = '', modelId = ''] = model.spec.split(':')
  // A replayed tool call must carry the API of the model that continues the conversation.
  let api = 'anthropic-messages'
  try {
    const { getModel } = await import('@earendil-works/pi-ai/compat')
    api = getModel(provider as never, modelId as never)?.api ?? api
  } catch {
    // Unknown model (offline tests): the default is only a label there.
  }
  const messages: Message[] = []
  let callNumber = 0
  for (const entry of scenario.history ?? []) {
    if ('user' in entry) {
      messages.push({ role: 'user', content: await resolveText(entry.user, context), timestamp: Date.now() })
      continue
    }
    const id = `toolu_history_${++callNumber}`
    messages.push({
      role: 'assistant',
      content: [{ type: 'toolCall', id, name: entry.call.name, arguments: entry.call.args as never }],
      api,
      provider,
      model: modelId,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: 'toolUse',
      timestamp: Date.now(),
    } as unknown as Message)
    messages.push({
      role: 'toolResult',
      toolCallId: id,
      toolName: entry.call.name,
      content: [{ type: 'text', text: await resolveText(entry.result, context) }],
      isError: entry.isError ?? false,
      timestamp: Date.now(),
    } as Message)
  }
  return messages
}

/** A pi-ai backed turn, with keys from the environment only (no database or stored accounts). */
export async function piTurn(): Promise<AgentTurn> {
  const { completeSimple, getEnvApiKey, getModel } = await import('@earendil-works/pi-ai/compat')
  return async ({ systemPrompt, messages, tools, model, signal }) => {
    const [provider = '', modelId = '', level] = model.spec.split(':')
    const message = await completeSimple(
      getModel(provider as never, modelId as never),
      { systemPrompt, messages, tools },
      {
        apiKey: getEnvApiKey(provider),
        maxTokens: 16_000,
        reasoning: level && level !== 'off' ? (level as 'minimal' | 'low' | 'medium' | 'high') : undefined,
        signal,
      }
    )
    if (message.stopReason === 'error') throw new Error(message.errorMessage ?? 'model error')
    const text = message.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n')
    const calls = message.content.flatMap((block) =>
      block.type === 'toolCall'
        ? [{ id: block.id, name: block.name, args: block.arguments as Record<string, unknown> }]
        : []
    )
    return { text, calls, message }
  }
}

/** The first spec in the tier's chain whose provider has an API key in the environment. */
export async function usableModel(root: string, tier: string): Promise<ModelChoice | null> {
  const { getEnvApiKey } = await import('@earendil-works/pi-ai/compat')
  const spec = tierChain(root, tier).find((candidate) => getEnvApiKey(candidate.split(':')[0] ?? ''))
  return spec ? { spec, tier } : null
}

// ---------------------------------------------------------------------------
// Comparison: Noah's no-regression rule
// ---------------------------------------------------------------------------

export interface ScenarioComparison {
  scenario: string
  must: boolean
  model: string
  old: { passed: number; runs: number }
  new: { passed: number; runs: number }
  regressed: boolean
}

export interface Comparison {
  rows: ScenarioComparison[]
  totals: Record<string, { old: number; new: number; runs: number }>
  /** Why the comparison fails; empty when the new text passes. */
  failures: string[]
}

/**
 * The new text passes when, for every model, each must scenario passes at least as often as with
 * the old text, and the total number of passing runs does not drop.
 */
export function compareRuns(
  scenarios: Pick<AgentScenario, 'name' | 'must'>[],
  oldRuns: RecordedRun[],
  newRuns: RecordedRun[]
): Comparison {
  const models = [...new Set([...oldRuns, ...newRuns].map((run) => run.model))]
  const rows: ScenarioComparison[] = []
  const totals: Comparison['totals'] = {}
  const failures: string[] = []
  const count = (runs: RecordedRun[], scenario: string, model: string) => {
    const matching = runs.filter((run) => run.scenario === scenario && run.model === model)
    return { passed: matching.filter((run) => run.verdict.pass).length, runs: matching.length }
  }
  for (const model of models) {
    const total = { old: 0, new: 0, runs: 0 }
    for (const scenario of scenarios) {
      const before = count(oldRuns, scenario.name, model)
      const after = count(newRuns, scenario.name, model)
      if (before.runs === 0 && after.runs === 0) continue
      const regressed = scenario.must && after.passed < before.passed
      if (regressed)
        failures.push(
          `${model}: must scenario ${scenario.name} passed ${after.passed} times, down from ${before.passed}`
        )
      rows.push({ scenario: scenario.name, must: scenario.must, model, old: before, new: after, regressed })
      total.old += before.passed
      total.new += after.passed
      total.runs += Math.max(before.runs, after.runs)
    }
    totals[model] = total
    if (total.new < total.old) failures.push(`${model}: ${total.new} passing runs in total, down from ${total.old}`)
  }
  return { rows, totals, failures }
}

export function renderComparison(comparison: Comparison, oldLabel: string, newLabel: string): string {
  const lines = [
    `Old: ${oldLabel}. New: ${newLabel}.`,
    '',
    '| Model | Scenario | Must | Old | New | |',
    '|---|---|---|---|---|---|',
    ...comparison.rows.map(
      (row) =>
        `| ${row.model} | ${row.scenario} | ${row.must ? 'yes' : ''} | ${row.old.passed}/${row.old.runs} | ${row.new.passed}/${row.new.runs} | ${row.regressed ? 'REGRESSED' : ''} |`
    ),
    '',
    ...Object.entries(comparison.totals).map(
      ([model, total]) => `Total for ${model}: old ${total.old}, new ${total.new} passing runs.`
    ),
    '',
    comparison.failures.length === 0
      ? 'Result: no regression.'
      : `Result: regression.\n${comparison.failures.map((failure) => `- ${failure}`).join('\n')}`,
  ]
  return lines.join('\n')
}
