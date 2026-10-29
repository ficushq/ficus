import { expect, test } from 'bun:test'
import { recoveryOperationKey as key } from './operation'

test('operation identities normalize target references, not timeout or edit contents', () => {
  expect(key('bash', { command: ' npm  test ', timeout: 1 })).toBe(key('bash', { command: 'npm\ttest', timeout: 99 }))
  expect(key('bash', { command: 'npm test' })).not.toBe(key('bash', { command: 'git status' }))
  expect(key('bash', { command: 'npm test' })).not.toBe(key('squad_bash', { command: 'npm test' }))
  expect(key('edit', { path: './src/file.ts', oldText: 'a' })).toBe(key('edit', { path: 'src/file.ts', oldText: 'b' }))
  expect(key('edit', { path: 'src/file.ts' })).not.toBe(key('edit', { path: 'notes.md' }))
  expect(key('fetch', { url: 'a', mode: 1 })).toBe(key('fetch', { mode: 1, url: 'a' }))
  expect(key('fetch', { url: 'a' })).not.toBe(key('fetch', { url: 'b' }))
})

test('command normalization does not collapse quoted data, heredocs, or escapes', () => {
  for (const [left, right] of [
    ["printf 'a  b'", "printf 'a b'"],
    ['printf "a  b"', 'printf "a b"'],
    ['cat <<EOF\na  b\nEOF', 'cat <<EOF\na b\nEOF'],
    ['echo a\\ b', 'echo a b'],
  ])
    expect(key('bash', { command: left })).not.toBe(key('bash', { command: right }))
})
