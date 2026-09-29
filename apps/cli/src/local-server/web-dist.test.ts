import { describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { builtWebBase, webDistWarning } from './web-dist'

const html = (base: string) =>
  `<!doctype html><html><head>\n<script type="module" crossorigin src="${base}assets/index-abc.js"></script>\n<link rel="stylesheet" crossorigin href="${base}assets/index-def.css">\n</head><body></body></html>\n`

describe('builtWebBase', () => {
  it('reads the base the bundle was built for from its asset URLs', () => {
    expect(builtWebBase(html('/'))).toBe('/')
    expect(builtWebBase(html('/tau/'))).toBe('/tau/')
    expect(builtWebBase(html('/a/b/'))).toBe('/a/b/')
  })
  it('is null when the page references no built assets', () => {
    expect(builtWebBase('<html></html>')).toBeNull()
  })
})

describe('webDistWarning', () => {
  let root: string
  const write = (base: string) => {
    mkdirSync(join(root, 'apps', 'web', 'dist'), { recursive: true })
    writeFileSync(join(root, 'apps', 'web', 'dist', 'index.html'), html(base))
  }
  it('is silent when the bundle matches APP_BASE_PATH, with or without slashes', () => {
    root = mkdtempSync(join(tmpdir(), 'ficus-web-dist-'))
    try {
      write('/tau/')
      expect(webDistWarning(root, { APP_BASE_PATH: '/tau' })).toBeNull()
      expect(webDistWarning(root, { APP_BASE_PATH: '/tau/' })).toBeNull()
      expect(webDistWarning(root, { APP_BASE_PATH: 'tau' })).toBeNull()
      write('/')
      expect(webDistWarning(root, {})).toBeNull()
      expect(webDistWarning(root, { APP_BASE_PATH: '' })).toBeNull()
      expect(webDistWarning(root, { APP_BASE_PATH: '/' })).toBeNull()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
  it('names both bases and the rebuild command when they disagree', () => {
    root = mkdtempSync(join(tmpdir(), 'ficus-web-dist-'))
    try {
      write('/')
      const warning = webDistWarning(root, { APP_BASE_PATH: '/tau' })
      expect(warning).toContain('built for base "/"')
      expect(warning).toContain('APP_BASE_PATH=/tau')
      expect(warning).toContain('bun run build:web')
      expect(warning).toContain('restart does not rebuild')
      write('/tau/')
      expect(webDistWarning(root, {})).toContain('built for base "/tau/"')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
  it('is silent when no bundle has been built or the page has no assets', () => {
    root = mkdtempSync(join(tmpdir(), 'ficus-web-dist-'))
    try {
      expect(webDistWarning(root, { APP_BASE_PATH: '/tau' })).toBeNull()
      mkdirSync(join(root, 'apps', 'web', 'dist'), { recursive: true })
      writeFileSync(join(root, 'apps', 'web', 'dist', 'index.html'), '<html></html>')
      expect(webDistWarning(root, { APP_BASE_PATH: '/tau' })).toBeNull()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
