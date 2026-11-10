#!/usr/bin/env bun
/**
 * Build invariant: apps/web/dist (with the farm built into dist/farm) serves at
 * any base path. Core rebases the absolute URLs in index.html per request
 * (apps/core/src/lib/web-serve.ts), so nothing else may hardcode the base:
 *
 * - no JS or CSS file references `/assets/…` or `/farm/assets/…` root-absolutely
 *   (Vite's renderBuiltUrl must have made them importer-relative);
 * - index.html and farm/index.html carry the `__FICUS_BASE_PATH__` placeholder
 *   Core fills in;
 * - the web manifest's start_url and scope are relative.
 *
 * Usage: bun scripts/check-web-dist-base.ts [distDir]  (default apps/web/dist)
 * Exits 1 and lists every problem when the invariant does not hold.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const PLACEHOLDER = '__FICUS_BASE_PATH__'
const ROOT_ABSOLUTE_ASSET = /["'`](?:\/[^"'`\s]*)?\/(?:farm\/)?assets\//

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) yield* walk(path)
    else yield path
  }
}

export function checkWebDistBase(dist: string): string[] {
  const problems: string[] = []
  if (!existsSync(join(dist, 'index.html'))) return [`${dist}/index.html does not exist: build the web app first`]

  for (const file of walk(dist)) {
    const rel = relative(dist, file)
    // The service worker and the voice worklet are served at their own fixed URL, never by base.
    if (rel === 'sw.js' || rel.startsWith('voice/')) continue
    if (!rel.endsWith('.js') && !rel.endsWith('.mjs') && !rel.endsWith('.css')) continue
    const match = ROOT_ABSOLUTE_ASSET.exec(readFileSync(file, 'utf8'))
    if (match) problems.push(`${rel} references a root-absolute asset URL: ${match[0]}…`)
  }

  for (const html of ['index.html', 'farm/index.html']) {
    const path = join(dist, html)
    if (!existsSync(path)) {
      problems.push(`${html} is missing`)
      continue
    }
    if (!readFileSync(path, 'utf8').includes(PLACEHOLDER)) problems.push(`${html} lacks the ${PLACEHOLDER} meta`)
  }

  const manifestPath = join(dist, 'manifest.webmanifest')
  if (!existsSync(manifestPath)) problems.push('manifest.webmanifest is missing')
  else {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { start_url?: string; scope?: string }
    for (const key of ['start_url', 'scope'] as const) {
      if (manifest[key]?.startsWith('/')) problems.push(`manifest.webmanifest ${key} is absolute: ${manifest[key]}`)
    }
  }
  return problems
}

if (import.meta.main) {
  const dist = process.argv[2] ?? join(import.meta.dir, '..', 'apps', 'web', 'dist')
  const problems = checkWebDistBase(dist)
  if (problems.length) {
    console.error(`The web build is not base-path independent (${dist}):`)
    for (const problem of problems) console.error(`  - ${problem}`)
    process.exit(1)
  }
  console.log(`${dist} is base-path independent.`)
}
