import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { DEFAULT_MAX_STEPS } from './define'
import { readAgentType } from './prompt'
import { defaultTierFor, parseTierOption, selectScenarioTiers, tierChain } from './run'
import { SCENARIOS } from './scenarios'
import { workingTreeVariant } from './variant'

/*
 * Offline checks for which tiers `bun run agents:eval` runs: no model, key or network. By default
 * each scenario runs only on its agent type's own configured tier; `--tier` replaces it explicitly.
 */

const root = workingTreeVariant().root
const VARIANTS = 2
const REPEATS = 3

/** The model the harness picks when only an Anthropic key is present, as in the guidance comparison. */
const anthropicModel = (tier: string) => tierChain(root, tier).find((spec) => spec.startsWith('anthropic:'))

describe('default tier selection', () => {
  test('each role keeps its own configured tier and exact model and effort', () => {
    expect(defaultTierFor(root, 'engineer')).toBe(readAgentType(root, 'engineer').tier!)
    expect(defaultTierFor(root, 'engineer')).toBe('standard')
    expect(defaultTierFor(root, 'manager')).toBe('standard')
    expect(defaultTierFor(root, 'reviewer')).toBe('deep')
    expect(anthropicModel('standard')).toBe('anthropic:claude-opus-5-5:medium')
    expect(anthropicModel('deep')).toBe('anthropic:claude-opus-5-5:high')
  })

  test('the default adds no fast cohort and never coerces the reviewer to standard', () => {
    const selection = selectScenarioTiers(root, SCENARIOS)
    expect(selection).toHaveLength(SCENARIOS.length)
    for (const { scenario, tier } of selection) {
      expect(tier).toBe(readAgentType(root, scenario.agentType).tier!)
      expect(tier).not.toBe('fast')
    }
    const reviewer = selection.filter(({ scenario }) => scenario.agentType === 'reviewer')
    expect(reviewer.length).toBeGreaterThan(0)
    expect(reviewer.every(({ tier }) => tier === 'deep')).toBe(true)
  })

  test('the current suite sizes to its runs, models and logical-turn ceiling', () => {
    // Derived from the real scenario and tier definitions; the numbers in the expectations below
    // describe today's suite (18 scenarios) and change whenever the authorized scenarios do.
    const selection = selectScenarioTiers(root, SCENARIOS)
    const runsByModel = new Map<string, number>()
    let maxTurns = 0
    for (const { scenario, tier } of selection) {
      const model = anthropicModel(tier)!
      runsByModel.set(model, (runsByModel.get(model) ?? 0) + VARIANTS * REPEATS)
      maxTurns += (scenario.maxSteps ?? DEFAULT_MAX_STEPS) * VARIANTS * REPEATS
    }
    const total = [...runsByModel.values()].reduce((sum, runs) => sum + runs, 0)
    expect(total).toBe(SCENARIOS.length * VARIANTS * REPEATS)
    expect(Object.fromEntries(runsByModel)).toEqual({
      'anthropic:claude-opus-5-5:medium': 96,
      'anthropic:claude-opus-5-5:high': 12,
    })
    expect(total).toBe(108)
    expect(maxTurns).toBe(1_092)
  })
})

describe('explicit --tier', () => {
  test('replaces every scenario default, so fast still runs when asked for', () => {
    const scenarios = SCENARIOS.filter(({ agentType }) => agentType === 'reviewer').slice(0, 1)
    expect(selectScenarioTiers(root, scenarios, parseTierOption(root, 'standard,fast'))).toEqual([
      { scenario: scenarios[0]!, tier: 'standard' },
      { scenario: scenarios[0]!, tier: 'fast' },
    ])
    expect(parseTierOption(root, 'fast')).toEqual(['fast'])
    expect(parseTierOption(root, ' deep , fast ')).toEqual(['deep', 'fast'])
  })

  test('absent means the defaults; bare, empty, repeated or unknown tiers are errors', () => {
    expect(parseTierOption(root, undefined)).toBeUndefined()
    expect(() => parseTierOption(root, true)).toThrow('--tier needs a comma-separated list of tiers')
    expect(() => parseTierOption(root, '')).toThrow('--tier needs a comma-separated list of tiers')
    expect(() => parseTierOption(root, 'standard,')).toThrow('--tier needs a comma-separated list of tiers')
    expect(() => parseTierOption(root, 'fast,fast')).toThrow('--tier lists fast more than once')
    expect(() => parseTierOption(root, 'default')).toThrow('Unknown tier default')
    expect(() => parseTierOption(root, '--record')).toThrow('Unknown tier --record')
    expect(() => parseTierOption(root, '../agent-types/engineer')).toThrow('Unknown tier')
  })

  test('the CLI rejects an invalid --tier before resolving refs or calling a model', () => {
    const cli = join(import.meta.dir, '../../scripts/agent-eval.ts')
    for (const [args, message] of [
      [['--tier'], '--tier needs a comma-separated list of tiers'],
      [['--tier', 'nope'], 'Unknown tier nope'],
    ] as const) {
      const result = spawnSync(process.execPath, [cli, 'completion-ready', ...args], {
        encoding: 'utf8',
        env: { ...process.env, ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '', ZAI_API_KEY: '' },
        timeout: 60_000,
      })
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain(message)
    }
  }, 120_000)
})
