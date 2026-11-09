import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import * as yaml from 'js-yaml'
import { join } from 'node:path'
import { MONOREPO_ROOT } from '../../lib/paths'
const mapping: Record<string, string[]> = {
  fast: [],
  standard: ['subagent', 'artifact-builder-default', 'general', 'engineer', 'system-manager', 'manager', 'sysops'],
  deep: ['consultant', 'reviewer'],
  exhaustive: ['architect', 'security-auditor'],
}
describe('shipped model tier chain proof', () => {
  test('assigns every migrated type to its target tier with no duplicate override chain', () => {
    for (const [tier, ids] of Object.entries(mapping))
      for (const id of ids) {
        const value = yaml.load(readFileSync(join(MONOREPO_ROOT, 'config/agent-types', `${id}.yaml`), 'utf8')) as {
          tier?: string
          model?: string
        }
        expect(value.tier).toBe(tier)
        expect(value.model).toBe('')
      }
  })
  test('every shipped tier has a non-empty three-entry chain', () => {
    for (const tier of Object.keys(mapping)) {
      const value = yaml.load(readFileSync(join(MONOREPO_ROOT, 'config/model-tiers', `${tier}.yaml`), 'utf8')) as {
        chain?: string
      }
      expect(value.chain).toBeTruthy()
      expect(value.chain!.split(',')).toHaveLength(3)
    }
  })
})
