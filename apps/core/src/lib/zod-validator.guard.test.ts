import { expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

const SRC = join(import.meta.dir, '..')
const WRAPPER = 'lib/zod-validator.ts'

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : sourceFiles(path)
    return /\.tsx?$/.test(entry.name) ? [path] : []
  })
}

test("routes validate through lib/zod-validator, which keeps the 400 body's issues", () => {
  const offenders = sourceFiles(SRC)
    .map((path) => relative(SRC, path))
    .filter((path) => path !== WRAPPER)
    .filter((path) => /['"]@hono\/zod-validator['"]/.test(readFileSync(join(SRC, path), 'utf8')))
  // Import zValidator from src/lib/zod-validator instead: on zod 4 the package's default 400 body
  // serializes a ZodError without its issues.
  expect(offenders).toEqual([])
})
