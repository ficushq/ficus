import { expect, test } from 'bun:test'
import { validateAgentTypeConfig, validateSquadPresetConfig } from './validate-config'
import { validateSkillSupportFiles } from '../config-sync/skill-sync'
for (const field of ['skills', 'includes', 'extensions', 'toolsAllow', 'toolsDeny'])
  test(field + ' refuses count before validation/DB loops', async () => {
    await expect(validateAgentTypeConfig({ [field]: Array(101).fill(null) })).rejects.toThrow('Use at most 100')
  })
for (const field of ['defaultAgents', 'scheduleTemplates'])
  test(field + ' refuses count before reference queries', async () => {
    await expect(validateSquadPresetConfig({ [field]: Array(101).fill(null) })).rejects.toThrow('Use at most 100')
  })
test('support files gate keys before invalid entries', () => {
  expect(() =>
    validateSkillSupportFiles(Object.fromEntries(Array.from({ length: 257 }, (_, i) => ['bad' + i, null])))
  ).toThrow('Use at most 256')
})
test('integration maps and capability lists gate before other config work', async () => {
  await expect(
    validateAgentTypeConfig({ integrationCapabilities: { version: 1, allow: { provider: Array(101).fill(null) } } })
  ).rejects.toThrow('Use at most 100')
  await expect(
    validateAgentTypeConfig({
      integrationCapabilities: {
        version: 1,
        allow: Object.fromEntries(Array.from({ length: 257 }, (_, i) => ['bad' + i, []])),
      },
    })
  ).rejects.toThrow('Use at most 256')
})
