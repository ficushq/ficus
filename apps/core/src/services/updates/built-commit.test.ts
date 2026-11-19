import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { advanceBuiltCommit, readBuiltCommit, seedBuiltCommit, updateStateDir, writeBuiltCommit } from './built-commit'

const A = 'a'.repeat(40)
const B = 'b'.repeat(40)
const C = 'c'.repeat(40)

describe('the built-commit record', () => {
  let dir: string
  beforeEach(() => {
    dir = join(mkdtempSync(join(tmpdir(), 'ficus-built-commit-')), '.ficus')
  })
  afterEach(() => rmSync(join(dir, '..'), { recursive: true, force: true }))

  it('lives next to the update status file', () => {
    expect(updateStateDir('/srv/ficus')).toBe('/srv/ficus/.ficus')
  })

  it('reads nothing until a commit is recorded, and creates its directory when one is', () => {
    expect(readBuiltCommit(dir)).toBeUndefined()
    writeBuiltCommit(dir, A)
    expect(readBuiltCommit(dir)).toBe(A)
    expect(JSON.parse(readFileSync(join(dir, 'built-commit.json'), 'utf8')).recordedAt).toBeString()
  })

  it('ignores a record that is not a full commit id, and never writes one', () => {
    writeBuiltCommit(dir, A)
    writeBuiltCommit(dir, 'main')
    expect(readBuiltCommit(dir)).toBe(A)
    writeFileSync(join(dir, 'built-commit.json'), JSON.stringify({ sha: 'abc123' }))
    expect(readBuiltCommit(dir)).toBeUndefined()
    writeFileSync(join(dir, 'built-commit.json'), '{')
    expect(readBuiltCommit(dir)).toBeUndefined()
  })

  it('seeds only when nothing is recorded', () => {
    seedBuiltCommit(dir, A)
    seedBuiltCommit(dir, B)
    expect(readBuiltCommit(dir)).toBe(A)
  })

  it('advances from the commit a run started on, but not past builds still owed from an older one', () => {
    advanceBuiltCommit(dir, A, B)
    expect(readBuiltCommit(dir)).toBe(B)
    advanceBuiltCommit(dir, B, C)
    expect(readBuiltCommit(dir)).toBe(C)
    // Recorded A, but this run only built B..C: A..B is still owed.
    writeBuiltCommit(dir, A)
    advanceBuiltCommit(dir, B, C)
    expect(readBuiltCommit(dir)).toBe(A)
  })
})
