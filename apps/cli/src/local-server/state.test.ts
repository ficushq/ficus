import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import {
  NoRootError,
  UnknownInstanceError,
  canonicalRoot,
  findInstanceByRoot,
  getStatePath,
  isCheckout,
  readRegistry,
  readRegistryStrict,
  removeInstance,
  resolveRoot,
  resolveSetupRoot,
  upsertInstance,
} from './state'

let tmp: string
beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'tau-state-')))
})
afterEach(() => rmSync(tmp, { recursive: true, force: true }))

function makeCheckout(dir: string) {
  mkdirSync(join(dir, '.git'), { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'tau' }))
}

const record = (root: string, port = 3000, supervisor: 'pm2' | 'launchd' | 'systemd-user' = 'pm2') => ({
  root,
  port,
  supervisor,
  createdAt: 't',
  updatedAt: 't',
})

describe('canonicalRoot', () => {
  it('uses lexical absolute identity for nonexistent targets and broken symlinks', () => {
    const missing = join(tmp, 'does-not-exist', 'leaf')
    expect(canonicalRoot(missing)).toBe(resolve(missing))

    const broken = join(tmp, 'broken-link')
    symlinkSync(join(tmp, 'missing-target'), broken)
    expect(canonicalRoot(broken)).toBe(resolve(broken))
    expect(canonicalRoot(broken)).not.toBe(canonicalRoot(join(tmp, 'missing-target')))
  })
})

describe('state file', () => {
  it('defaults to ~/.tau/cli/local-server.json and honours FICUS_LOCAL_SERVER_STATE', () => {
    expect(getStatePath({})).toMatch(/\/\.tau\/cli\/local-server\.json$/)
    expect(getStatePath({ FICUS_LOCAL_SERVER_STATE: '/x/y.json' })).toBe('/x/y.json')
  })
  it('round-trips an instance through a directory it has to create, and removes it', () => {
    const path = join(tmp, 'nested', 'state.json')
    upsertInstance('tau', record('/r'), {}, path)
    expect(readRegistry(path).instances.tau).toEqual(record('/r'))
    removeInstance('tau', path)
    expect(readRegistry(path).instances).toEqual({})
  })
  it('writes the registry atomically and at mode 0600, tightening a looser existing file', () => {
    const path = join(tmp, 'secure.json')
    writeFileSync(path, '{}', { mode: 0o644 })
    upsertInstance('tau', record('/r'), {}, path)
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(readRegistry(path).instances.tau).toEqual(record('/r'))
    // The temporary file the write goes through never survives it.
    expect(readdirSync(tmp)).toEqual(['secure.json'])
  })
  it('reads a malformed file as an empty registry', () => {
    const path = join(tmp, 'bad.json')
    writeFileSync(path, '{nope')
    expect(readRegistry(path).instances).toEqual({})
  })
})

describe('registry', () => {
  it('migrates v2 records to pm2 but requires explicit valid supervisors in v3', () => {
    const path = join(tmp, 'versions.json')
    writeFileSync(
      path,
      JSON.stringify({ version: 2, default: 'tau', instances: { tau: { root: '/old', port: 3000 } } })
    )
    expect(readRegistry(path).instances.tau?.supervisor).toBe('pm2')

    writeFileSync(
      path,
      JSON.stringify({
        version: 3,
        instances: {
          tau: record('/a', 3000, 'launchd'),
          smoke: record('/b', 3100, 'systemd-user'),
          missing: { root: '/c', port: 3200 },
          unknown: { root: '/d', port: 3300, supervisor: 'forever' },
        },
      })
    )
    expect(readRegistry(path).instances).toEqual({
      tau: record('/a', 3000, 'launchd'),
      smoke: record('/b', 3100, 'systemd-user'),
    })
  })

  it('fails closed for future versions and drops unsafe or non-normalized keys', () => {
    const path = join(tmp, 'closed.json')
    writeFileSync(path, JSON.stringify({ version: 99, instances: { tau: record('/r') } }))
    expect(readRegistry(path)).toEqual({ version: 3, instances: {} })
    writeFileSync(
      path,
      JSON.stringify({
        version: 3,
        instances: {
          Smoke: record('/a'),
          '../api': record('/b'),
          good: record('/c'),
        },
      })
    )
    expect(Object.keys(readRegistry(path).instances)).toEqual(['good'])
  })

  it('rejects incomplete v3 containers, records, and defaults while preserving a permissive read view', () => {
    const path = join(tmp, 'strict-shapes.json')
    const invalid = [
      { version: 3 },
      { version: 3, instances: [] },
      { version: 3, instances: {}, default: 42 },
      { version: 3, instances: {}, default: 'tau' },
      { version: 3, instances: { tau: { root: '/a', port: 3000, supervisor: 'pm2' } } },
      { version: 3, instances: { tau: { ...record('/a'), port: 1.5 } } },
      { version: 3, instances: { tau: { ...record('relative') } } },
    ]
    for (const value of invalid) {
      const original = JSON.stringify(value)
      writeFileSync(path, original)
      expect(() => readRegistryStrict(path)).toThrow(/registry/i)
      expect(() => upsertInstance('tau', record('/replacement'), {}, path)).toThrow(/registry/i)
      expect(readFileSync(path, 'utf8')).toBe(original)
      expect(readRegistry(path).instances).toEqual({})
    }
  })

  it('migrates a v1 file to one instance named tau, which is the default', () => {
    const path = join(tmp, 'v1.json')
    writeFileSync(path, JSON.stringify({ root: '/r', port: 3000, createdAt: 'c', updatedAt: 'u' }))
    expect(readRegistry(path)).toEqual({
      version: 3,
      default: 'tau',
      instances: { tau: { root: '/r', port: 3000, supervisor: 'pm2', createdAt: 'c', updatedAt: 'u' } },
    })
    // …and the migration is read-only: nothing is rewritten until an upsert.
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ root: '/r', port: 3000, createdAt: 'c', updatedAt: 'u' })
  })
  it('reads an empty registry for a missing or malformed file', () => {
    expect(readRegistry(join(tmp, 'missing.json'))).toEqual({ version: 3, instances: {} })
    const bad = join(tmp, 'bad.json')
    writeFileSync(bad, '{nope')
    expect(readRegistry(bad)).toEqual({ version: 3, instances: {} })
    const wrongShape = join(tmp, 'wrong.json')
    writeFileSync(wrongShape, JSON.stringify({ version: 3, instances: { tau: { root: 5 } } }))
    expect(readRegistry(wrongShape)).toEqual({ version: 3, instances: {} })
  })
  it('upsert makes the first instance the default and leaves it alone without makeDefault', () => {
    const path = join(tmp, 'r.json')
    upsertInstance('tau', record('/a'), {}, path)
    expect(readRegistry(path).default).toBe('tau')
    upsertInstance('smoke', record('/b', 3100), {}, path)
    expect(readRegistry(path).default).toBe('tau')
    expect(readRegistry(path).instances.smoke).toEqual(record('/b', 3100))
    upsertInstance('smoke', record('/b', 3100), { makeDefault: true }, path)
    expect(readRegistry(path).default).toBe('smoke')
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(JSON.parse(readFileSync(path, 'utf8')).version).toBe(3)
  })
  it('remove reassigns the default to a remaining instance, then clears it', () => {
    const path = join(tmp, 'r.json')
    upsertInstance('tau', record('/a'), {}, path)
    upsertInstance('smoke', record('/b', 3100), {}, path)
    removeInstance('tau', path)
    expect(readRegistry(path)).toEqual({ version: 3, default: 'smoke', instances: { smoke: record('/b', 3100) } })
    removeInstance('smoke', path)
    expect(readRegistry(path)).toEqual({ version: 3, instances: {} })
  })
  it('finds the instance that owns a root', () => {
    const path = join(tmp, 'r.json')
    upsertInstance('tau', record('/a'), {}, path)
    upsertInstance('smoke', record('/b', 3100), {}, path)
    expect(findInstanceByRoot('/b', path)).toEqual({ label: 'smoke', record: record('/b', 3100) })
    expect(findInstanceByRoot('/nope', path)).toBeUndefined()
  })
})

describe('resolveRoot', () => {
  it('prefers the flag, then env, then --instance, then the cwd walk-up, then the registry default', () => {
    const flagRoot = join(tmp, 'flag')
    const envRoot = join(tmp, 'env')
    const instRoot = join(tmp, 'inst')
    const cwdRoot = join(tmp, 'cwd')
    const defaultRoot = join(tmp, 'default')
    for (const d of [flagRoot, envRoot, instRoot, cwdRoot, defaultRoot]) makeCheckout(d)
    const statePath = join(tmp, 's.json')
    upsertInstance('tau', record(defaultRoot), { makeDefault: true }, statePath)
    upsertInstance('smoke', record(instRoot, 3100), {}, statePath)
    const nested = join(cwdRoot, 'apps', 'core')
    mkdirSync(nested, { recursive: true })
    const outside = join(tmp, 'outside')
    mkdirSync(outside, { recursive: true })

    expect(
      resolveRoot({ flag: flagRoot, env: { FICUS_SERVER_ROOT: envRoot }, instance: 'smoke', statePath, cwd: nested })
    ).toBe(flagRoot)
    expect(resolveRoot({ env: { FICUS_SERVER_ROOT: envRoot }, instance: 'smoke', statePath, cwd: nested })).toBe(
      envRoot
    )
    expect(resolveRoot({ env: {}, instance: 'smoke', statePath, cwd: nested })).toBe(instRoot)
    // FICUS_INSTANCE is the env form of --instance.
    expect(resolveRoot({ env: { FICUS_INSTANCE: 'smoke' }, statePath, cwd: nested })).toBe(instRoot)
    // The checkout you are standing in outranks the registry default.
    expect(resolveRoot({ env: {}, statePath, cwd: nested })).toBe(cwdRoot)
    expect(resolveRoot({ env: {}, statePath, cwd: outside })).toBe(defaultRoot)
  })
  it('ignores an unknown or malformed FICUS_INSTANCE and carries on resolving', () => {
    const instRoot = join(tmp, 'inst')
    const cwdRoot = join(tmp, 'cwd')
    const defaultRoot = join(tmp, 'default')
    for (const d of [instRoot, cwdRoot, defaultRoot]) makeCheckout(d)
    const statePath = join(tmp, 's.json')
    upsertInstance('tau', record(defaultRoot), { makeDefault: true }, statePath)
    upsertInstance('smoke', record(instRoot, 3100), {}, statePath)
    const nested = join(cwdRoot, 'apps', 'core')
    mkdirSync(nested, { recursive: true })
    const outside = join(tmp, 'outside')
    mkdirSync(outside, { recursive: true })

    // FICUS_INSTANCE is ambient (a checkout's .env exports it), so a label this
    // machine has no entry for must not break an answerable command.
    expect(resolveRoot({ env: { FICUS_INSTANCE: 'ghost' }, statePath, cwd: nested })).toBe(cwdRoot)
    expect(resolveRoot({ env: { FICUS_INSTANCE: 'Bad Label' }, statePath, cwd: nested })).toBe(cwdRoot)
    expect(resolveRoot({ env: { FICUS_INSTANCE: 'ghost' }, statePath, cwd: outside })).toBe(defaultRoot)
    // The flag is a request: it is honoured or refused, never ignored.
    expect(() => resolveRoot({ env: {}, instance: 'ghost', statePath, cwd: nested })).toThrow(UnknownInstanceError)
    expect(() => resolveRoot({ env: {}, instance: 'Bad Label', statePath, cwd: nested })).toThrow(
      /--instance must match/
    )
  })
  it('names the known instances when --instance does not match one', () => {
    const statePath = join(tmp, 's.json')
    const dir = join(tmp, 'a')
    makeCheckout(dir)
    upsertInstance('tau', record(dir), {}, statePath)
    upsertInstance('smoke', record(dir, 3100), {}, statePath)
    expect(() => resolveRoot({ env: {}, instance: 'nope', statePath, cwd: dir })).toThrow(UnknownInstanceError)
    try {
      resolveRoot({ env: {}, instance: 'nope', statePath, cwd: dir })
    } catch (error) {
      expect((error as Error).message).toContain('unknown instance "nope"')
      expect((error as Error).message).toContain('smoke, tau')
    }
  })
  it('refuses a stale --instance root, and lets the same stale FICUS_INSTANCE fall through', () => {
    const statePath = join(tmp, 's.json')
    const gone = join(tmp, 'gone')
    const cwdRoot = join(tmp, 'cwd')
    makeCheckout(cwdRoot)
    const nested = join(cwdRoot, 'apps', 'core')
    mkdirSync(nested, { recursive: true })
    // Registered, but the checkout it names has since been deleted.
    upsertInstance('smoke', record(gone, 3100), {}, statePath)
    expect(() => resolveRoot({ env: {}, instance: 'smoke', statePath, cwd: nested })).toThrow(NoRootError)
    expect(() => resolveRoot({ env: {}, instance: 'smoke', statePath, cwd: nested })).toThrow(gone)
    // The ambient label reports nothing: the checkout you are in still answers.
    expect(resolveRoot({ env: { FICUS_INSTANCE: 'smoke' }, statePath, cwd: nested })).toBe(cwdRoot)
  })
  it('rejects a flag/env root that is not a checkout', () => {
    expect(() => resolveRoot({ flag: tmp, env: {}, statePath: join(tmp, 'none.json'), cwd: tmp })).toThrow(NoRootError)
  })
  it('throws NoRootError when nothing resolves', () => {
    expect(() => resolveRoot({ env: {}, statePath: join(tmp, 'none.json'), cwd: tmp })).toThrow(NoRootError)
  })
  it('isCheckout needs .git and package.json name tau', () => {
    expect(isCheckout(tmp)).toBe(false)
    makeCheckout(tmp)
    expect(isCheckout(tmp)).toBe(true)
    writeFileSync(join(tmp, 'package.json'), JSON.stringify({ name: 'other' }))
    expect(isCheckout(tmp)).toBe(false)
  })
  it('isCheckout accepts a checkout whose package.json is named ficus, and still accepts tau', () => {
    mkdirSync(join(tmp, '.git'), { recursive: true })
    writeFileSync(join(tmp, 'package.json'), JSON.stringify({ name: 'ficus' }))
    expect(isCheckout(tmp)).toBe(true)
    writeFileSync(join(tmp, 'package.json'), JSON.stringify({ name: 'tau' }))
    expect(isCheckout(tmp)).toBe(true)
  })
})

describe('resolveSetupRoot', () => {
  it('ignores the state file and uses the cwd checkout (setup must configure the checkout you are in)', () => {
    const stateRoot = join(tmp, 'state')
    const cwdRoot = join(tmp, 'cwd')
    for (const d of [stateRoot, cwdRoot]) makeCheckout(d)
    const statePath = join(tmp, 's.json')
    upsertInstance('tau', record(stateRoot), {}, statePath)
    const nested = join(cwdRoot, 'apps', 'core')
    mkdirSync(nested, { recursive: true })

    expect(resolveSetupRoot({ env: { FICUS_LOCAL_SERVER_STATE: statePath }, cwd: nested })).toBe(cwdRoot)
  })
  it('prefers the flag, then the env, over the cwd walk-up', () => {
    const flagRoot = join(tmp, 'flag')
    const envRoot = join(tmp, 'env')
    const cwdRoot = join(tmp, 'cwd')
    for (const d of [flagRoot, envRoot, cwdRoot]) makeCheckout(d)
    expect(resolveSetupRoot({ flag: flagRoot, env: { FICUS_SERVER_ROOT: envRoot }, cwd: cwdRoot })).toBe(flagRoot)
    expect(resolveSetupRoot({ env: { FICUS_SERVER_ROOT: envRoot }, cwd: cwdRoot })).toBe(envRoot)
  })
  it('rejects a flag/env root that is not a checkout', () => {
    expect(() => resolveSetupRoot({ flag: tmp, env: {}, cwd: tmp })).toThrow(NoRootError)
  })
  it('throws NoRootError when no checkout contains the cwd', () => {
    expect(() => resolveSetupRoot({ env: {}, cwd: tmp })).toThrow(NoRootError)
  })
})

describe('mutation-red registry guards', () => {
  it('refuses to mutate an unreadable, future-version, or invalid-record registry with recovery guidance', () => {
    const path = join(tmp, 'bad-registry.json')
    writeFileSync(path, '{nope')
    expect(() => upsertInstance('tau', record('/a'), {}, path)).toThrow(/registry is unreadable/)
    expect(() => removeInstance('tau', path)).toThrow(/registry is unreadable/)
    expect(() => findInstanceByRoot('/a', path)).toThrow(/registry is unreadable/)

    writeFileSync(path, JSON.stringify({ version: 99, instances: { tau: record('/a') } }))
    expect(() => upsertInstance('tau', record('/a'), {}, path)).toThrow(/version 99/)
    expect(() => findInstanceByRoot('/a', path)).toThrow(/version 99/)

    writeFileSync(path, JSON.stringify({ version: 3, instances: { tau: { root: '/a', port: 1 } } }))
    expect(() => upsertInstance('tau', record('/a'), {}, path)).toThrow(/invalid record/)
    expect(() => findInstanceByRoot('/a', path)).toThrow(/invalid record/)
    // Read-only listing still answers (empty), never throws.
    expect(readRegistry(path).instances).toEqual({})
  })
})
