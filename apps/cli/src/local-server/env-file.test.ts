import { describe, expect, it } from 'bun:test'
import { mergeEnvFile, parseEnvFile, renderEnvDiff } from './env-file'

const base = `# Web
FICUS_SERVE_WEB=1
FICUS_API_URL=http://localhost:3000

# Encryption
FICUS_ENCRYPTION_KEY=
APP_URL=https://your-domain.com
DATABASE_URL=postgres://postgres:postgres@localhost:5432/tau
`

describe('parseEnvFile', () => {
  it('returns key/value pairs and ignores comments and blanks', () => {
    expect(parseEnvFile(base)).toEqual({
      FICUS_SERVE_WEB: '1',
      FICUS_API_URL: 'http://localhost:3000',
      FICUS_ENCRYPTION_KEY: '',
      APP_URL: 'https://your-domain.com',
      DATABASE_URL: 'postgres://postgres:postgres@localhost:5432/tau',
    })
  })
  it('strips matching quotes', () => {
    expect(parseEnvFile(`A="x y"\nB='z'\n`)).toEqual({ A: 'x y', B: 'z' })
  })
})

describe('parseEnvFile legacy TAU_ lines (one release)', () => {
  it('reads a TAU_X line as FICUS_X, and a FICUS_X line in the same file wins (except for encryption keys)', () => {
    expect(parseEnvFile('TAU_INSTANCE=smoke\nTAU_PASSWORD=old\nFICUS_PASSWORD=new\nPORT=3100\n')).toEqual({
      FICUS_INSTANCE: 'smoke',
      FICUS_PASSWORD: 'new',
      PORT: '3100',
    })
  })

  it('keeps the TAU_ value of a conflicting encryption key, as the boot bridge does', () => {
    expect(parseEnvFile('TAU_ENCRYPTION_KEY=store-key\nFICUS_ENCRYPTION_KEY=other-key\n')).toEqual({
      FICUS_ENCRYPTION_KEY: 'store-key',
    })
  })
})

describe('mergeEnvFile', () => {
  it('fills an empty managed key in place and keeps everything else byte-identical', () => {
    const out = mergeEnvFile(base, [{ key: 'FICUS_ENCRYPTION_KEY', value: 'abc', explicit: false }])
    expect(out).toBe(base.replace('FICUS_ENCRYPTION_KEY=', 'FICUS_ENCRYPTION_KEY=abc'))
  })
  it('keeps an existing non-empty value when the update is not explicit', () => {
    const out = mergeEnvFile(base, [{ key: 'FICUS_API_URL', value: 'http://localhost:4000', explicit: false }])
    expect(out).toBe(base)
  })
  it('replaces an existing value when the update is explicit', () => {
    const out = mergeEnvFile(base, [{ key: 'FICUS_API_URL', value: 'http://localhost:4000', explicit: true }])
    expect(out).toContain('FICUS_API_URL=http://localhost:4000\n')
    expect(out).not.toContain('localhost:3000')
  })
  it('treats the .env.example APP_URL placeholder as empty', () => {
    const out = mergeEnvFile(base, [{ key: 'APP_URL', value: 'http://localhost:3000', explicit: false }])
    expect(out).toContain('APP_URL=http://localhost:3000\n')
  })
  it('appends missing keys under one trailer comment, in order', () => {
    const out = mergeEnvFile(base, [
      { key: 'FICUS_SANDBOX_RUNTIME', value: 'host', explicit: true },
      { key: 'FICUS_SYSTEM_LOG_PROVIDER', value: 'pm2', explicit: false },
    ])
    expect(
      out.endsWith('\n# --- added by tau setup ---\nFICUS_SANDBOX_RUNTIME=host\nFICUS_SYSTEM_LOG_PROVIDER=pm2\n')
    ).toBe(true)
  })
  it('reuses an existing trailer instead of adding a second one', () => {
    const once = mergeEnvFile(base, [{ key: 'X', value: '1', explicit: true }])
    const twice = mergeEnvFile(once, [{ key: 'Y', value: '2', explicit: true }])
    expect(twice.split('# --- added by tau setup ---').length).toBe(2)
    expect(twice.endsWith('X=1\nY=2\n')).toBe(true)
  })
  it('quotes values containing whitespace or #', () => {
    const out = mergeEnvFile('', [
      { key: 'A', value: 'x y', explicit: true },
      { key: 'B', value: 'p#q', explicit: true },
    ])
    expect(out).toContain('A="x y"\n')
    expect(out).toContain('B="p#q"\n')
  })
  it('handles a commented-out key by appending, not by editing the comment', () => {
    const out = mergeEnvFile('# HOME_DIR=~/.tau\n', [{ key: 'HOME_DIR', value: '/data', explicit: true }])
    expect(out).toContain('# HOME_DIR=~/.tau\n')
    expect(out).toContain('\nHOME_DIR=/data\n')
  })
})

describe('renderEnvDiff', () => {
  it('lists changed keys and redacts secrets', () => {
    const after = mergeEnvFile(base, [
      { key: 'FICUS_ENCRYPTION_KEY', value: 'deadbeef', explicit: false },
      { key: 'PORT', value: '3000', explicit: false },
    ])
    const lines = renderEnvDiff(base, after, ['FICUS_ENCRYPTION_KEY'])
    expect(lines).toEqual(['FICUS_ENCRYPTION_KEY=<redacted>', 'PORT=3000'])
  })
})
