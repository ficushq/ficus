import { describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  DEFAULT_INSTANCE,
  derivePorts,
  generateEcosystem,
  instanceNames,
  normalizeLabel,
  readInstanceLabel,
} from './instance'
import { SetupOptionsError } from './options'

const EXAMPLE = readFileSync(join(__dirname, '../../../../ecosystem.config.example.js'), 'utf8')

describe('instanceNames', () => {
  it('names the default instance ficus', () => {
    expect(DEFAULT_INSTANCE).toBe('ficus')
    expect(instanceNames(DEFAULT_INSTANCE)).toEqual({
      label: 'ficus',
      api: 'ficus-api',
      worker: 'ficus-worker',
      container: 'postgres-ficus',
      volume: 'ficus_postgres-data',
      homeDir: undefined,
    })
  })
  it('inserts the label after ficus for every resource of a second instance', () => {
    expect(instanceNames('lab').container).toBe('postgres-ficus-lab')
    expect(instanceNames('smoke')).toEqual({
      label: 'smoke',
      api: 'ficus-smoke-api',
      worker: 'ficus-smoke-worker',
      container: 'postgres-ficus-smoke',
      volume: 'ficus-smoke_postgres-data',
      homeDir: '~/.ficus-smoke',
    })
  })
  it('refuses to derive names for a retired registration', () => {
    expect(() => instanceNames('smoke', 1)).toThrow(SetupOptionsError)
  })
})

describe('normalizeLabel', () => {
  it('lowercases a valid label', () => {
    expect(normalizeLabel('Smoke')).toBe('smoke')
    expect(normalizeLabel('ci2')).toBe('ci2')
    expect(normalizeLabel('a-b-c')).toBe('a-b-c')
  })
  it('rejects a label with a space', () => {
    expect(() => normalizeLabel('bad label')).toThrow(SetupOptionsError)
    expect(() => normalizeLabel('bad label')).toThrow(/bad label/)
  })
  it('rejects a label that does not start or end alphanumeric, and one of 32 characters', () => {
    expect(() => normalizeLabel('-lead')).toThrow(SetupOptionsError)
    expect(() => normalizeLabel('trail-')).toThrow(SetupOptionsError)
    expect(() => normalizeLabel('')).toThrow(SetupOptionsError)
    expect(normalizeLabel('a')).toBe('a')
    expect(normalizeLabel('a'.repeat(31))).toBe('a'.repeat(31))
    expect(() => normalizeLabel('a'.repeat(32))).toThrow(SetupOptionsError)
  })
})

describe('derivePorts', () => {
  it('puts the worker at +2 and its event port at +3', () => {
    expect(derivePorts(3100)).toEqual({ workerPort: 3102, eventPort: 3103 })
    expect(derivePorts(3000)).toEqual({ workerPort: 3002, eventPort: 3003 })
  })
})

describe('readInstanceLabel', () => {
  it('reads FICUS_INSTANCE from the checkout .env and defaults to ficus', () => {
    const root = mkdtempSync(join(tmpdir(), 'ficus-instance-'))
    try {
      expect(readInstanceLabel(root)).toBe('ficus')
      writeFileSync(join(root, '.env'), 'PORT=3100\nFICUS_INSTANCE=smoke\n')
      expect(readInstanceLabel(root)).toBe('smoke')
      writeFileSync(join(root, '.env'), 'FICUS_INSTANCE=\n')
      expect(readInstanceLabel(root)).toBe('ficus')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('generateEcosystem', () => {
  it('substitutes exactly the four app-name strings and leaves the rest byte-identical', () => {
    const out = generateEcosystem(EXAMPLE, instanceNames('smoke'))
    expect(out).toContain("name: 'ficus-smoke-api',")
    expect(out).toContain("name: 'ficus-smoke-worker',")
    expect(out).toContain("FICUS_PM2_API_NAME: 'ficus-smoke-api',")
    expect(out).toContain("FICUS_PM2_WORKER_NAME: 'ficus-smoke-worker',")
    expect(out).not.toContain("'ficus-api'")
    expect(out).not.toContain("'ficus-worker'")
    // Nothing else moved: undoing the four substitutions restores the file byte for byte.
    expect(out.replaceAll('ficus-smoke-api', 'ficus-api').replaceAll('ficus-smoke-worker', 'ficus-worker')).toBe(
      EXAMPLE
    )
  })
  it('is a no-op for the default label', () => {
    expect(generateEcosystem(EXAMPLE, instanceNames('ficus'))).toBe(EXAMPLE)
  })
  it('throws when a substitution target is missing', () => {
    expect(() => generateEcosystem('module.exports = {}\n', instanceNames('smoke'))).toThrow(/ficus-api/)
    const missingWorker = EXAMPLE.replace("FICUS_PM2_WORKER_NAME: 'ficus-worker',", '')
    expect(() => generateEcosystem(missingWorker, instanceNames('smoke'))).toThrow(/FICUS_PM2_WORKER_NAME/)
  })
})
