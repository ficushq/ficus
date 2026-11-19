import { expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Approved recording budget: retain the current comparison and minimal regression traces, not
// every superseded cohort. Raising this cap requires an explicit reviewed change.
const RECORDINGS_MAX_BYTES = 1_048_576

function directoryBytes(directory: string): number {
  return readdirSync(directory, { withFileTypes: true }).reduce((bytes, entry) => {
    if (entry.isSymbolicLink()) throw new Error('Recording directories must not contain symbolic links')
    const path = join(directory, entry.name)
    return bytes + (entry.isDirectory() ? directoryBytes(path) : statSync(path).size)
  }, 0)
}

test('all recording artifacts recursively fit in the approved 1 MiB budget', () => {
  const bytes = directoryBytes(join(import.meta.dir, 'recordings'))
  expect({ bytes, withinBudget: bytes <= RECORDINGS_MAX_BYTES }).toEqual({ bytes, withinBudget: true })
})

test('the size guard counts nested and non-JSON artifacts and refuses symlink bypasses', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ficus-recording-size-test-'))
  try {
    mkdirSync(join(directory, 'nested'))
    writeFileSync(join(directory, 'README.md'), 'abc')
    writeFileSync(join(directory, 'nested', 'trace.json'), '{}')
    expect(directoryBytes(directory)).toBe(5)
    symlinkSync(join(directory, 'README.md'), join(directory, 'bypass'))
    expect(() => directoryBytes(directory)).toThrow('must not contain symbolic links')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
