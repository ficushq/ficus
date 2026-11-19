import { expect, test } from 'bun:test'
import { PUBLIC_VOICE_ID_PATTERN } from '@ficus/shared'
import { profileIdFromName } from './profileId'
test('profile names generate valid bounded ids; collisions stay deterministic for the create API to reject', () => {
  expect(profileIdFromName('Default')).toBe('default-voice')
  expect(profileIdFromName('From GitHub')).toBe('from-github')
  expect(profileIdFromName('  Café / TEAM! ')).toBe('cafe-team')
  expect(profileIdFromName('日本語')).toBe('from-github')
  expect(profileIdFromName('---')).toBe('from-github')
  expect(profileIdFromName('One Team')).toBe(profileIdFromName('One-Team'))
  for (const name of ['', '9 Cats', 'x'.repeat(200), 'x'.repeat(99) + ' ---']) {
    const id = profileIdFromName(name)
    expect(PUBLIC_VOICE_ID_PATTERN.test(id)).toBe(true)
    expect(id.length).toBeLessThanOrEqual(100)
  }
})
