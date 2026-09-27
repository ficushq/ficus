// apps/cli/src/docs-links.test.ts
import { describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join, relative, resolve } from 'path'

const repoRoot = resolve(import.meta.dir, '..', '..', '..')

/** Every markdown file under `dir`, recursively. */
function walkMd(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry)
    if (statSync(p).isDirectory()) out.push(...walkMd(p))
    else if (p.endsWith('.md')) out.push(p)
  }
  return out
}

const FILES = [
  'README.md',
  'SETUP.md',
  'AGENTS.md',
  'apps/web/DESIGN.md',
  'scripts/setup/README.md',
  ...walkMd(join(repoRoot, 'docs')).map((f) => relative(repoRoot, f)),
]

// Inline links: [text](target "title" | 'title' | (title))
const INLINE_LINK_RE = /\[[^\]]*\]\(([^)\s]+)(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\)/g
// Reference definitions: [label]: target "title" | 'title' | (title)
const REF_DEF_RE = /^[ \t]{0,3}\[([^\]]+)\]:[ \t]+(\S+)(?:[ \t]+(?:"[^"]*"|'[^']*'|\([^)]*\)))?[ \t]*$/gm
// Reference uses: [text][label], [label][] (collapsed), and [label] (shortcut,
// only when a definition exists)
const REF_USE_RE = /\[([^\]]+)\](?:(?<!\\)\[([^\]]*)\])?/g

/**
 * GitHub heading slug: lowercase, drop backticks, remove every character
 * that isn't a letter/number/underscore/space/hyphen (GitHub keeps `_` in
 * anchors), trim, then map EACH space to a hyphen (GitHub does not collapse
 * consecutive hyphens/spaces).
 */
export function slug(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/`/g, '')
    .replace(/\t/g, ' ')
    .replace(/[^\p{L}\p{N}_ -]/gu, '')
    .trim()
    .replace(/ /g, '-')
}

/** Strip fenced code blocks (``` or ~~~) so links inside them are never scanned. */
function stripFences(text: string): string {
  const out: string[] = []
  let fenceChar: string | null = null
  for (const line of text.split('\n')) {
    const m = /^\s*(```+|~~~+)/.exec(line)
    if (fenceChar) {
      if (m && m[1][0] === fenceChar) fenceChar = null
      continue
    }
    if (m) {
      fenceChar = m[1][0]
      continue
    }
    out.push(line)
  }
  return out.join('\n')
}

function headingsFromText(text: string): Set<string> {
  const out = new Set<string>()
  const counts = new Map<string, number>()
  for (const line of text.split('\n')) {
    const m = /^#{1,6}\s+(.+?)\s*#*$/.exec(line)
    if (!m) continue
    const base = slug(m[1])
    const n = counts.get(base) ?? 0
    counts.set(base, n + 1)
    out.add(n === 0 ? base : `${base}-${n}`)
  }
  return out
}

const headingCache = new Map<string, Set<string>>()
function headings(file: string): Set<string> {
  let set = headingCache.get(file)
  if (!set) {
    set = headingsFromText(readFileSync(file, 'utf8'))
    headingCache.set(file, set)
  }
  return set
}

/** Validate one link target the way inline and reference links both must pass. */
function checkTarget(file: string, target: string): string | undefined {
  if (/^(https?:|mailto:|ficus:)/.test(target)) return undefined
  const [path, anchor] = target.split('#')
  const abs = path ? resolve(dirname(file), path) : file
  if (!existsSync(abs)) return `${target} → missing file ${abs}`
  if (anchor && abs.endsWith('.md') && !headings(abs).has(anchor)) return `${target} → missing anchor #${anchor}`
  return undefined
}

function findBrokenLinks(file: string, rawText: string): string[] {
  const text = stripFences(rawText)
  const broken: string[] = []
  // Reference definitions first: label (case-insensitive) → target.
  const defs = new Map<string, string>()
  for (const m of text.matchAll(REF_DEF_RE)) defs.set(m[1].toLowerCase(), m[2])
  const record = (target: string) => {
    const problem = checkTarget(file, target)
    if (problem) broken.push(problem)
  }
  for (const m of text.matchAll(INLINE_LINK_RE)) record(m[1])
  for (const m of text.matchAll(REF_USE_RE)) {
    // Skip inline links already handled above (they are followed by a paren).
    const after = text.slice(m.index! + m[0].length)
    if (after.startsWith('(')) continue
    // Skip definitions themselves: a definition line starts with the bracket
    // we just matched; a following ':' makes this a definition, not a use.
    if (/^[ \t]*:/.test(after)) continue
    const collapsedOrFull = m[2] !== undefined
    const label = collapsedOrFull ? m[2] || m[1] : m[1]
    const target = defs.get(label.toLowerCase())
    if (!target) continue // undefined shortcut reference = plain text, not a link
    record(target)
  }
  return broken
}

describe('markdown links in the setup docs', () => {
  it('repoRoot resolves to the monorepo root', () => {
    expect(existsSync(join(repoRoot, 'package.json'))).toBe(true)
  })

  for (const rel of FILES) {
    it(`${rel} has no broken relative links or anchors`, () => {
      const file = join(repoRoot, rel)
      expect(existsSync(file)).toBe(true)
      const broken = findBrokenLinks(file, readFileSync(file, 'utf8'))
      expect(broken).toEqual([])
    })
  }
})

describe('slug', () => {
  it('`host` — no sandbox → host--no-sandbox', () => {
    expect(slug('`host` — no sandbox')).toBe('host--no-sandbox')
  })

  it('Stop / Continue → stop--continue', () => {
    expect(slug('Stop / Continue')).toBe('stop--continue')
  })

  it('4. Configure OAuth & Permissions → 4-configure-oauth--permissions', () => {
    expect(slug('4. Configure OAuth & Permissions')).toBe('4-configure-oauth--permissions')
  })

  it('8. Monitoring & Troubleshooting → 8-monitoring--troubleshooting', () => {
    expect(slug('8. Monitoring & Troubleshooting')).toBe('8-monitoring--troubleshooting')
  })

  it('Contents → contents', () => {
    expect(slug('Contents')).toBe('contents')
  })

  it('keeps underscores (GitHub anchors keep word characters)', () => {
    expect(slug('Native in-place resize rollout (PLATFORM_NATIVE_RESIZE_ENABLED)')).toBe(
      'native-in-place-resize-rollout-platform_native_resize_enabled'
    )
  })

  it('duplicate headings get a -1 suffix', () => {
    const text = ['## Contents', '', 'text', '', '## Contents', ''].join('\n')
    const result = headingsFromText(text)
    expect(result.has('contents')).toBe(true)
    expect(result.has('contents-1')).toBe(true)
  })
})

describe('stripFences', () => {
  it('ignores a link inside a fenced code block while still reporting the same link outside it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'docs-links-test-'))
    const file = join(dir, 'fixture.md')
    const fence = '```'
    const text = ['# Fixture', '', fence, '[broken](./nope.md)', fence, '', '[broken](./nope.md)', ''].join('\n')
    writeFileSync(file, text)
    try {
      const broken = findBrokenLinks(file, text)
      expect(broken).toEqual([`./nope.md → missing file ${resolve(dir, './nope.md')}`])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('link forms', () => {
  const runOn = (text: string): string[] => {
    const dir = mkdtempSync(join(tmpdir(), 'docs-links-forms-'))
    const file = join(dir, 'fixture.md')
    try {
      return findBrokenLinks(file, text)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
  it('parses double-quoted, single-quoted and parenthesised titles', () => {
    for (const link of ['[a](./x.md "t")', "[a](./x.md 't')", '[a](./x.md (t))']) {
      const broken = runOn(link)
      expect(broken).toHaveLength(1)
      expect(broken[0]).toContain('./x.md')
    }
  })
  it('parses reference-style links and their definitions', () => {
    const broken = runOn(['# F', '', '[text][ref]', '', '[ref]: ./missing.md', ''].join('\n'))
    expect(broken).toHaveLength(1)
    expect(broken[0]).toContain('./missing.md')
    // External definition targets are skipped like inline https links.
    expect(runOn(['# F', '', '[text][ref]', '', '[ref]: https://example.com/x', ''].join('\n'))).toEqual([])
    // Collapsed reference use: [label][]
    expect(runOn(['# F', '', '[ref][]', '', '[ref]: ./missing.md', ''].join('\n'))).toHaveLength(1)
    // Shortcut use: bare [label] resolves against its definition…
    expect(runOn(['# F', '', 'see [ref] here', '', '[ref]: ./missing.md', ''].join('\n'))).toHaveLength(1)
    // …but an undefined bare bracket is plain text, not a broken link.
    expect(runOn(['# F', '', 'an [undefined] bracket', ''].join('\n'))).toEqual([])
  })
})
