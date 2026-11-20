import { afterEach, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { db, squads } from '../../../db'
import { getSettingsStore } from '../../settings/store'
import {
  LINEAR_RULE_AUDIENCES_MIGRATED_SETTING_KEY,
  legacyLinearRulesKeepingBehavior,
  migrateLinearRuleAudiences,
} from './rule-audience-migration'

const rule = (id: string, output: string, audience: string) => ({
  id,
  enabled: true,
  source: { integration: 'linear', output, version: 1 },
  filters: { squadRouting: true, audience },
  action: { type: 'notify-manager' },
})
const created: string[] = []
afterEach(async () => {
  for (const id of created.splice(0)) await db.delete(squads).where(eq(squads.id, id))
  await getSettingsStore().set(LINEAR_RULE_AUDIENCES_MIGRATED_SETTING_KEY, '', 'test')
})

test('stored Linear rules keep their old behavior: audiences become any, except assignment rules', () => {
  const rules = [
    rule('comment', 'issue.comment', 'assigned-or-mentioned'),
    rule('updated', 'issue.updated', 'connected-account'),
    rule('assigned', 'issue.assigned', 'connected-account'),
    rule('wide', 'issue.updated', 'any'),
  ]
  expect(legacyLinearRulesKeepingBehavior(rules)).toEqual([
    rule('comment', 'issue.comment', 'any'),
    rule('updated', 'issue.updated', 'any'),
    rule('assigned', 'issue.assigned', 'connected-account'),
    rule('wide', 'issue.updated', 'any'),
  ])
  expect(legacyLinearRulesKeepingBehavior([rule('assigned', 'issue.assigned', 'connected-account')])).toBeNull()
  expect(legacyLinearRulesKeepingBehavior(undefined)).toBeNull()
})

test('the upgrade rewrites stored rules once and leaves rules saved afterwards alone', async () => {
  await getSettingsStore().initialize()
  await getSettingsStore().set(LINEAR_RULE_AUDIENCES_MIGRATED_SETTING_KEY, '', 'test')
  const [squad] = await db
    .insert(squads)
    .values({
      name: `linear-audience-${crypto.randomUUID()}`,
      purpose: 'test',
      metadata: {
        linear: [{ teamId: 't' }],
        integrationRules: { linear: [rule('comment', 'issue.comment', 'assigned-or-mentioned')] },
      },
    })
    .returning()
  created.push(squad!.id)
  expect(await migrateLinearRuleAudiences()).toBeGreaterThanOrEqual(1)
  const read = async () =>
    ((await db.select().from(squads).where(eq(squads.id, squad!.id)))[0]!.metadata as any).integrationRules.linear[0]
      .filters.audience
  expect(await read()).toBe('any')
  // A rule saved after the upgrade keeps its audience: the step runs once.
  await db
    .update(squads)
    .set({ metadata: { integrationRules: { linear: [rule('comment', 'issue.comment', 'assigned-or-mentioned')] } } })
    .where(eq(squads.id, squad!.id))
  expect(await migrateLinearRuleAudiences()).toBe(0)
  expect(await read()).toBe('assigned-or-mentioned')
})
