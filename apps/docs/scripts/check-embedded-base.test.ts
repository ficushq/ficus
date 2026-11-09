import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { checkEmbeddedBase } from './check-embedded-base'

const PAGE = '<meta name="ficus-docs-base" content="__FICUS_DOCS_BASE__"><a href="/docs/guide/">g</a>'
const SEARCH =
  'n=function(e){return"/docs/"+e};new t({baseUrl:`/docs/`,bundlePath:`/docs/`.replace(/\\/$/,``)+`/pagefind/`})'

let root: string | undefined
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true })
  root = undefined
})

function build(files: Record<string, string>): string {
  root = mkdtempSync(join(tmpdir(), 'ficus-docs-base-'))
  const all = { 'index.html': PAGE, '_astro/search.js': SEARCH, 'pagefind/pagefind.js': 'import("./x.js")', ...files }
  for (const [path, body] of Object.entries(all)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), body)
  }
  return root
}

test('a build whose base references Core rebases passes', () => {
  expect(
    checkEmbeddedBase(build({ '_astro/ui.js': 'o=`/pagefind/`;k===`/`', '_astro/a.css': 'a{b:url(./x.png)}' }))
  ).toEqual([])
})

test('every way the base can escape the rewrite is reported', () => {
  const problems = checkEmbeddedBase(
    build({
      'guide/index.html': '<a href="/docs/x/">x</a>',
      'img/index.html': `${PAGE}<img srcset="/docs/a.png 1x, /docs/b.png 2x">`,
      '_astro/other.js': 'const b="/docs";const c=`/docs/x`',
      '_astro/a.css': 'a{b:url(/docs/x.png)}',
      'pagefind/pagefind.js': 'const b="/docs/"',
    })
  )
  expect(problems).toEqual(
    expect.arrayContaining([
      'guide/index.html lacks the __FICUS_DOCS_BASE__ meta',
      'img/index.html has a srcset with more than one /docs URL',
      '_astro/other.js has the base in an unexpected literal: "/docs"',
      '_astro/other.js has the base in an unexpected literal: `/docs/x`',
      '_astro/a.css has a root-absolute url()',
      'pagefind/pagefind.js has a /docs/ literal',
    ])
  )
})

test('a Search script that stops passing the base to Pagefind is reported', () => {
  expect(checkEmbeddedBase(build({ '_astro/search.js': 'new t({baseUrl:e})' }))).toEqual([
    'no _astro script passes `/docs/` as the Pagefind baseUrl and bundlePath',
  ])
})

test('a missing build is reported', () => {
  expect(checkEmbeddedBase(join(tmpdir(), 'ficus-docs-base-missing'))[0]).toContain('does not exist')
})
