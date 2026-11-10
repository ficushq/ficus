import { describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { staleWebDistWarning } from './web-dist'

const current =
  '<!doctype html><html><head><meta name="ficus-base-path" content="__FICUS_BASE_PATH__" />\n<script type="module" crossorigin src="/assets/index-abc.js"></script></head></html>\n'
const legacy =
  '<!doctype html><html><head><script type="module" crossorigin src="/tau/assets/index-abc.js"></script></head></html>\n'

describe('staleWebDistWarning', () => {
  let root: string
  const write = (html: string) => {
    mkdirSync(join(root, 'apps', 'web', 'dist'), { recursive: true })
    writeFileSync(join(root, 'apps', 'web', 'dist', 'index.html'), html)
  }

  it('is silent for a bundle that reads its base path at runtime', () => {
    root = mkdtempSync(join(tmpdir(), 'ficus-web-dist-'))
    try {
      write(current)
      expect(staleWebDistWarning(root)).toBeNull()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('names the rebuild command for a bundle that predates runtime base paths', () => {
    root = mkdtempSync(join(tmpdir(), 'ficus-web-dist-'))
    try {
      write(legacy)
      const warning = staleWebDistWarning(root)
      expect(warning).toContain('predates runtime base paths')
      expect(warning).toContain('bun run build:web')
      expect(warning).toContain('restart does not rebuild')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('is silent when no bundle has been built', () => {
    root = mkdtempSync(join(tmpdir(), 'ficus-web-dist-'))
    try {
      expect(staleWebDistWarning(root)).toBeNull()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
