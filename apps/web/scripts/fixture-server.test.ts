/** Runs real Vite against an empty dependency cache, so it takes several seconds. From apps/web:
 * bun test scripts/fixture-server.test.ts
 */
import { afterAll, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startFixtureServer } from './fixture-server'

const cacheDir = await mkdtemp(join(tmpdir(), 'fixture-server-cache-'))
const metadataPath = join(cacheDir, 'deps', '_metadata.json')
afterAll(() => rm(cacheDir, { recursive: true, force: true }))

test(
  'a cold cache is built and written before the server is returned, then shared by other fixtures',
  async () => {
    const first = await startFixtureServer({
      path: '/storage-banner-fixture',
      entry: '/scripts/fixtures/storage-banner.tsx',
      logLevel: 'silent',
      cacheDir,
    })
    let built: { hash: string; optimized: Record<string, unknown> }
    let builtAt: number
    try {
      // Written before startFixtureServer returned, while no page was ever requested.
      built = JSON.parse(await readFile(metadataPath, 'utf8'))
      builtAt = (await stat(metadataPath)).mtimeMs
      expect(Object.keys(built.optimized)).toEqual(expect.arrayContaining(['react', 'react-dom/client']))
      const page = await fetch(`${first.resolvedUrls!.local[0]!}storage-banner-fixture?appearance=dark`)
      expect(page.headers.get('content-type')).toBe('text/html')
      expect(await page.text()).toContain('<script type="module" src="/scripts/fixtures/storage-banner.tsx">')
    } finally {
      await first.close()
    }

    // Another check, serving every HTML request, reuses the same cache instead of rebuilding it.
    const second = await startFixtureServer({ entry: '/scripts/fixtures/spend.tsx', logLevel: 'silent', cacheDir })
    try {
      expect(JSON.parse(await readFile(metadataPath, 'utf8')).hash).toBe(built.hash)
      expect((await stat(metadataPath)).mtimeMs).toBe(builtAt)
      const url = second.resolvedUrls!.local[0]!
      const route = await fetch(`${url}settings?section=storage`, { headers: { accept: 'text/html' } })
      expect(await route.text()).toContain('<script type="module" src="/scripts/fixtures/spend.tsx">')
      // Non-HTML requests still reach Vite.
      const module = await fetch(`${url}scripts/fixtures/spend.tsx`)
      expect(module.headers.get('content-type')).toContain('javascript')
    } finally {
      await second.close()
    }
  },
  { timeout: 180_000 }
)
