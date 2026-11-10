import { describe, expect, test } from 'bun:test'
import { acquireDomHarness } from '../test/domHarness'
import { appBasePath, appBasePrefix, readAppBasePath } from './basePath'

async function withMeta(content: string | null, run: () => void) {
  const dom = await acquireDomHarness({
    url: 'http://h.local/ficus/settings',
    configureWindow: (w) => {
      if (content !== null)
        w.document.head.insertAdjacentHTML('beforeend', `<meta name="ficus-base-path" content="${content}">`)
    },
  })
  try {
    run()
  } finally {
    await dom.cleanup()
  }
}

describe('runtime base path', () => {
  test('reads the meta Core rendered', async () => {
    await withMeta('/ficus/', () => {
      expect(appBasePath()).toBe('/ficus/')
      expect(appBasePrefix()).toBe('/ficus')
    })
  })

  test('adds a missing trailing slash', async () => {
    await withMeta('/ficus', () => expect(readAppBasePath()).toBe('/ficus/'))
    await withMeta('/a/b', () => expect(readAppBasePath()).toBe('/a/b/'))
  })

  test('the root renders as / and an empty prefix', async () => {
    await withMeta('/', () => {
      expect(appBasePath()).toBe('/')
      expect(appBasePrefix()).toBe('')
    })
  })

  test('falls back to the build base for an unrendered placeholder or a missing meta', async () => {
    await withMeta('__FICUS_BASE_PATH__', () => expect(readAppBasePath()).toBe('/'))
    await withMeta(null, () => expect(readAppBasePath()).toBe('/'))
  })

  test('rejects values that are not a plain same-origin path', async () => {
    for (const bad of ['//evil.example', '/a b', 'ficus', 'https://evil.example/', '/a\\b']) {
      await withMeta(bad, () => expect(readAppBasePath()).toBe('/'))
    }
  })

  test('without a document it uses the build base', () => {
    expect(readAppBasePath(undefined)).toBe('/')
  })
})
