import { expect, test } from 'bun:test'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkLinks } from './check-links'

async function fixture(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'ficus-docs-links-'))
  try {
    await mkdir(join(root, 'guide'))
    await writeFile(join(root, 'guide/index.html'), '<h1 id="first-task">First task</h1>')
    await writeFile(join(root, 'logo.svg'), '<svg/>')
    await run(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

test('checks relative and canonical links, encoded anchors, and local assets', async () => {
  await fixture(async (root) => {
    await writeFile(
      join(root, 'index.html'),
      '<a href="guide/#first%2Dtask">Guide</a><a href="https://docs.ficus.sh/guide/?from=home#first-task">Canonical</a><img src="/logo.svg"><a href="https://example.com/remote/">External</a>'
    )
    expect(await checkLinks(root)).toEqual([])
  })
})

test('reports broken routes, anchors, and assets in generated HTML', async () => {
  await fixture(async (root) => {
    await writeFile(
      join(root, 'index.html'),
      '<a href="/missing/">Missing</a><a href="/guide/#typo">Anchor</a><img src="/missing.svg">'
    )
    const errors = await checkLinks(root)
    expect(errors).toHaveLength(3)
    expect(errors.some((error) => error.includes('missing anchor /guide/#typo'))).toBe(true)
    expect(errors.some((error) => error.includes('missing target /missing/'))).toBe(true)
    expect(errors.some((error) => error.includes('missing target /missing.svg'))).toBe(true)
  })
})

test('resolves nested relative links and rejects malformed encoded paths', async () => {
  await fixture(async (root) => {
    await writeFile(join(root, 'index.html'), '<h1 id="home">Home</h1>')
    await writeFile(join(root, 'guide/index.html'), '<a href="../#home">Home</a><a href="/%ZZ">Invalid</a>')
    expect(await checkLinks(root)).toEqual(['guide/: invalid URL encoding /%ZZ'])
  })
})

test('checks resource links without treating the generated 404 canonical URL as a page', async () => {
  await fixture(async (root) => {
    await writeFile(
      join(root, '404.html'),
      '<link rel="canonical" href="https://docs.ficus.sh/404/"><link rel="icon" href="/logo.svg"><link rel="stylesheet" href="/missing.css">'
    )
    expect(await checkLinks(root)).toEqual(['404.html: missing target /missing.css'])
  })
})

test('embedded links stay under the docs base and resolve pages and search assets', async () => {
  await fixture(async (root) => {
    await writeFile(join(root, 'index.html'), '<a href="/docs/guide/#first-task">Guide</a><img src="/docs/logo.svg">')
    expect(await checkLinks(root, '/docs/')).toEqual([])
    await writeFile(join(root, 'index.html'), '<a href="/guide/">Escaped base</a>')
    expect(await checkLinks(root, '/docs/')).toEqual([': target escapes docs base /guide/'])
  })
})
