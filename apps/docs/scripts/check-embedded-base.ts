#!/usr/bin/env bun
/**
 * Build invariant for the embedded documentation (apps/core/docs-dist).
 *
 * Core serves one build at `/docs/` and under a base path (`/ficus/docs/`) by
 * rebasing, per request, the attribute values that start with `/docs` in each
 * page and every quoted `/docs/` literal in `_astro/*.js`
 * (apps/core/src/lib/docs-serve.ts). That only covers the whole build while:
 *
 * - every page carries the `__FICUS_DOCS_BASE__` meta Core fills in;
 * - no `srcset` lists a second `/docs` URL (only the first value is rebased);
 * - every quoted literal in `_astro/*.js` that starts with `/docs` is exactly
 *   `/docs/`, and the Search script passes it as Pagefind's baseUrl and bundlePath;
 * - no stylesheet uses a root-absolute `url(/…)`;
 * - Pagefind's own scripts carry no `/docs/` literal (they load relative to themselves).
 *
 * An Astro or Starlight upgrade that moves the base somewhere else fails here.
 * Usage: bun scripts/check-embedded-base.ts [docsDist]
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PLACEHOLDER = '__FICUS_DOCS_BASE__'

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) yield* walk(path)
    else yield path
  }
}

export function checkEmbeddedBase(dist: string): string[] {
  if (!existsSync(join(dist, 'index.html'))) return [`${dist}/index.html does not exist: run build:embedded first`]
  const problems: string[] = []
  let searchConfigured = false
  for (const file of walk(dist)) {
    const rel = relative(dist, file)
    const text = () => readFileSync(file, 'utf8')
    if (rel.endsWith('.html')) {
      const html = text()
      if (!html.includes(PLACEHOLDER)) problems.push(`${rel} lacks the ${PLACEHOLDER} meta`)
      if (/srcset="[^"]*,\s*\/docs/.test(html)) problems.push(`${rel} has a srcset with more than one /docs URL`)
    } else if (rel.startsWith('_astro/') && rel.endsWith('.js')) {
      const js = text()
      for (const [literal] of js.matchAll(/(["'`])\/docs[^"'`]*\1/g)) {
        if (literal.slice(1, -1) !== '/docs/') problems.push(`${rel} has the base in an unexpected literal: ${literal}`)
      }
      if (/baseUrl:(["'`])\/docs\/\1/.test(js) && /bundlePath:(["'`])\/docs\/\1/.test(js)) searchConfigured = true
    } else if (rel.startsWith('_astro/') && rel.endsWith('.css')) {
      if (/url\(\s*["']?\//.test(text())) problems.push(`${rel} has a root-absolute url()`)
    } else if (rel.startsWith('pagefind/') && rel.endsWith('.js')) {
      if (/["'`]\/docs\//.test(text())) problems.push(`${rel} has a /docs/ literal`)
    }
  }
  if (!searchConfigured) problems.push('no _astro script passes `/docs/` as the Pagefind baseUrl and bundlePath')
  return problems
}

if (import.meta.main) {
  const dist = resolve(process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '../../core/docs-dist'))
  const problems = checkEmbeddedBase(dist)
  if (problems.length) {
    console.error(`The embedded documentation build cannot be served under a base path (${dist}):`)
    for (const problem of problems) console.error(`  - ${problem}`)
    process.exit(1)
  }
  console.log('Embedded documentation base references are all rebased by Core.')
}
