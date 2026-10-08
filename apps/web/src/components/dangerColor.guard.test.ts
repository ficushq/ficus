import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

// `text-danger` is not a Tailwind color in this app, so it compiles to nothing and error text
// silently renders in the default color. Use `text-status-danger-600 dark:text-status-danger-400`.
const SRC = join(import.meta.dir, '..')
const UNDEFINED_DANGER = /(?<![\w:-])(?:[a-z-]+:)*(?:text|bg|border)-danger(?![\w-])/

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return name === 'node_modules' ? [] : sources(path)
    return /\.(tsx?|css)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : []
  })
}

describe('danger color classes', () => {
  test('no source uses the undefined text-/bg-/border-danger utilities', () => {
    const offenders = sources(SRC)
      .filter((path) => UNDEFINED_DANGER.test(readFileSync(path, 'utf8')))
      .map((path) => relative(SRC, path))
    expect(offenders).toEqual([])
  })

  test('the guard recognises the undefined utility and ignores the defined ones', () => {
    expect(UNDEFINED_DANGER.test('className="text-sm text-danger"')).toBe(true)
    expect(UNDEFINED_DANGER.test('className="hover:text-danger"')).toBe(true)
    expect(UNDEFINED_DANGER.test('className="text-status-danger-600 dark:text-status-danger-400"')).toBe(false)
    expect(UNDEFINED_DANGER.test('className="ficus-button ficus-button-danger"')).toBe(false)
  })
})
