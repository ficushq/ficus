import { expect, test } from 'bun:test'
import { tagName } from './People'

test('tags show a first name, or the start of an email, kept short', () => {
  expect(tagName('Rosa Díaz')).toBe('Rosa')
  expect(tagName('sam@example.com')).toBe('sam')
  expect(tagName('Bartholomew-Jones')).toBe('Bartholomew…')
})
