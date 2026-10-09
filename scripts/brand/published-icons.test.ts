import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PUBLISHED_ICON_COPIES, REPO_ROOT } from './generate'

// Compares committed files only; it never renders anything, so it needs no
// Chrome and no sharp decode. `bun run brand:generate` refreshes every copy
// this checks (see PUBLISHED_ICON_COPIES in generate.ts).

describe('published icon copies', () => {
  for (const { from, to } of PUBLISHED_ICON_COPIES) {
    it(`${to} is byte-identical to ${from}`, () => {
      const source = readFileSync(join(REPO_ROOT, from))
      const copy = readFileSync(join(REPO_ROOT, to))
      if (!copy.equals(source)) {
        throw new Error(`${to} differs from ${from}; run bun run brand:generate`)
      }
    })
  }
})
