import { describe, expect, test } from 'bun:test'
import * as yaml from 'js-yaml'
import { AgentTypeSync } from './agent-type-sync'

function minimalYaml(extraLines: string[] = []): string {
  return [
    'id: early-margin-test',
    'name: Early Margin Test',
    'model: anthropic:claude-sonnet-4-6',
    'systemPrompt: You are a test agent.',
    ...extraLines,
  ].join('\n')
}

describe('AgentTypeSync margin token fields', () => {
  const sync = new AgentTypeSync()

  test('maps margin token fields from yaml to record and comparable data', () => {
    const parsed = sync.parse(
      minimalYaml(['earlyMarginTokens: 30000', 'inFlightMarginTokens: 8192']),
      'early-margin-test.yaml'
    )

    expect(parsed.earlyMarginTokens).toBe(30000)
    expect(parsed.inFlightMarginTokens).toBe(8192)
    expect(sync.toRecord(parsed)).toMatchObject({ earlyMarginTokens: 30000, inFlightMarginTokens: 8192 })
    expect(
      sync.toComparable({ ...sync.toRecord(parsed), earlyMarginTokens: 30000, inFlightMarginTokens: 8192 })
    ).toMatchObject({
      earlyMarginTokens: 30000,
      inFlightMarginTokens: 8192,
    })
  })

  test('maps an absent earlyMarginTokens yaml field to null', () => {
    const parsed = sync.parse(minimalYaml(), 'early-margin-test.yaml')

    expect(sync.toRecord(parsed)).toMatchObject({ earlyMarginTokens: null, inFlightMarginTokens: null })
    expect(
      sync.toComparable({ ...sync.toRecord(parsed), earlyMarginTokens: null, inFlightMarginTokens: null })
    ).toMatchObject({
      earlyMarginTokens: null,
      inFlightMarginTokens: null,
    })
  })

  test('round-trips earlyMarginTokens to yaml only when set', () => {
    const withMargin = yaml.load(
      sync.toYaml({
        id: 'early-margin-test',
        name: 'Early Margin Test',
        model: 'anthropic:claude-sonnet-4-6',
        description: null,
        systemPrompt: 'You are a test agent.',
        skills: null,
        extensions: null,
        toolsAllow: null,
        toolsDeny: null,
        earlyMarginTokens: 30000,
        inFlightMarginTokens: 8192,
      })
    ) as Record<string, unknown>

    expect(withMargin.earlyMarginTokens).toBe(30000)
    expect(withMargin.inFlightMarginTokens).toBe(8192)

    const withoutMargin = yaml.load(
      sync.toYaml({
        id: 'early-margin-test',
        name: 'Early Margin Test',
        model: 'anthropic:claude-sonnet-4-6',
        description: null,
        systemPrompt: 'You are a test agent.',
        skills: null,
        extensions: null,
        toolsAllow: null,
        toolsDeny: null,
        earlyMarginTokens: null,
        inFlightMarginTokens: null,
      })
    ) as Record<string, unknown>

    expect(withoutMargin).not.toHaveProperty('earlyMarginTokens')
    expect(withoutMargin).not.toHaveProperty('inFlightMarginTokens')
  })
})
