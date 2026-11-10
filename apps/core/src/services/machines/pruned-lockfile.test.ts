import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { RUNTIME_EXTERNALS } from '../../../../../scripts/artifact/lib/assemble-core-artifact'
import {
  assertInstalledMatchesLock,
  type BunLockfile,
  listInstalledPackages,
  parseBunLockfile,
  prunedInstallPlan,
} from '../../../../../scripts/artifact/lib/pruned-lockfile'

const REPO_ROOT = join(import.meta.dir, '../../../../..')

/**
 * A lockfile shaped like the real one: `app` depends on `ext-a` and `ext-b`,
 * the `app` workspace resolves its own `ext-b` (key `app/ext-b`), `ext-a`
 * nests a private `dep` that differs from the hoisted one, `ext-b` has a
 * per-platform optional dependency and an optional peer, and `@scope/shared`
 * is reached from two places.
 */
function fixtureLock(): BunLockfile {
  return parseBunLockfile(`{
    "lockfileVersion": 1,
    "configVersion": 0,
    "workspaces": {
      "": { "name": "root", "devDependencies": { "ext-b": "^1.0.0", "dev-only": "^1" } },
      "apps/app": { "name": "app", "dependencies": { "ext-a": "^2.0.0", "ext-b": "^2.0.0", "unrelated": "^1" } },
    },
    "overrides": { "dep": "1.0.0", "dev-only": "1.0.0" },
    "packages": {
      "@scope/shared": ["@scope/shared@1.2.3", "", {}, "sha512-shared"],
      "app/ext-b": ["ext-b@2.0.0", "", { "dependencies": { "@scope/shared": "^1.2.0", "dep": "^1.0.0" }, "optionalDependencies": { "ext-b-linux": "2.0.0" }, "peerDependencies": { "canvas": "^3", "peer-req": "^1" }, "optionalPeers": ["canvas"] }, "sha512-b2"],
      "canvas": ["canvas@3.0.0", "", {}, "sha512-canvas"],
      "dep": ["dep@1.0.0", "", {}, "sha512-dep1"],
      "dev-only": ["dev-only@1.0.0", "", {}, "sha512-dev"],
      "ext-a": ["ext-a@2.1.0", "", { "dependencies": { "@scope/shared": "^1.0.0", "dep": "^2.0.0" } }, "sha512-a"],
      "ext-a/dep": ["dep@2.0.0", "", {}, "sha512-dep2"],
      "ext-b": ["ext-b@1.0.0", "", {}, "sha512-b1"],
      "ext-b-linux": ["ext-b-linux@2.0.0", "", { "os": "linux", "cpu": "x64" }, "sha512-linux"],
      "peer-req": ["peer-req@1.0.0", "", {}, "sha512-peer"],
      "unrelated": ["unrelated@1.0.0", "", {}, "sha512-unrelated"],
    },
  }`)
}

async function write(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, contents)
}

describe('prunedInstallPlan', () => {
  it('pins each external to the version its workspace resolves and carries exactly their closure', () => {
    const plan = prunedInstallPlan(fixtureLock(), { workspacePath: 'apps/app', packages: ['ext-a', 'ext-b'] })

    expect(plan.dependencies).toEqual({ 'ext-a': '2.1.0', 'ext-b': '2.0.0' })
    expect(plan.lockfile.workspaces).toEqual({
      '': { name: 'ficus-core-artifact-externals', dependencies: { 'ext-a': '2.1.0', 'ext-b': '2.0.0' } },
    })
    // The workspace prefix is dropped (`app/ext-b` -> `ext-b`), nesting is
    // kept (`ext-a/dep`), platform optionals and required peers are kept,
    // optional peers and other workspaces' packages are not.
    expect(Object.keys(plan.lockfile.packages)).toEqual([
      '@scope/shared',
      'dep',
      'ext-a',
      'ext-a/dep',
      'ext-b',
      'ext-b-linux',
      'peer-req',
    ])
    expect(plan.lockfile.packages['ext-b']).toEqual(fixtureLock().packages['app/ext-b']!)
    expect(plan.lockfile.lockfileVersion).toBe(1)
    expect(plan.lockfile.configVersion).toBe(0)
    expect([...plan.lockedVersions].sort()).toEqual([
      '@scope/shared@1.2.3',
      'dep@1.0.0',
      'dep@2.0.0',
      'ext-a@2.1.0',
      'ext-b-linux@2.0.0',
      'ext-b@2.0.0',
      'peer-req@1.0.0',
    ])
    // Only overrides that touch the closure travel with it.
    expect(plan.overrides).toEqual({ dep: '1.0.0' })
    expect(plan.lockfile.overrides).toEqual({ dep: '1.0.0' })
  })

  it('refuses a package the workspace does not depend on', () => {
    expect(() => prunedInstallPlan(fixtureLock(), { workspacePath: 'apps/app', packages: ['dev-only'] })).toThrow(
      /dev-only is not a dependency of apps\/app/
    )
  })

  it('refuses a lockfile that cannot resolve a required dependency, naming it', () => {
    const lock = fixtureLock()
    delete lock.packages['@scope/shared']
    expect(() => prunedInstallPlan(lock, { workspacePath: 'apps/app', packages: ['ext-a'] })).toThrow(
      /cannot resolve @scope\/shared, a dependency of ext-a@2\.1\.0/
    )
  })

  it('refuses an unknown workspace', () => {
    expect(() => prunedInstallPlan(fixtureLock(), { workspacePath: 'apps/nope', packages: ['ext-a'] })).toThrow(
      /no workspace apps\/nope/
    )
  })

  it('prunes the repository bun.lock for the artifact, pinning each external to what apps/core resolves', async () => {
    const lock = parseBunLockfile(await readFile(join(REPO_ROOT, 'bun.lock'), 'utf8'))
    const plan = prunedInstallPlan(lock, { workspacePath: 'apps/core', packages: RUNTIME_EXTERNALS })

    expect(Object.keys(plan.dependencies)).toEqual([...RUNTIME_EXTERNALS])
    for (const name of RUNTIME_EXTERNALS) {
      const entry = lock.packages[`core/${name}`] ?? lock.packages[name]!
      expect(`${name}@${plan.dependencies[name]}`).toBe(entry[0])
      expect(Bun.semver.satisfies(plan.dependencies[name]!, lock.workspaces['apps/core']!.dependencies![name]!)).toBe(
        true
      )
    }
    // Every carried entry is byte-for-byte a lockfile entry, integrity included. One resolution can
    // appear more than once (a top-level tslib@2.8.1 and a copy bundled inside another package).
    const original = new Map<string, string[]>()
    for (const entry of Object.values(lock.packages)) {
      original.set(entry[0], [...(original.get(entry[0]) ?? []), JSON.stringify(entry)])
    }
    for (const entry of Object.values(plan.lockfile.packages)) {
      expect(original.get(entry[0])).toContain(JSON.stringify(entry))
      expect(entry[3]).toMatch(/^sha512-/)
    }
  })
})

describe('assertInstalledMatchesLock', () => {
  const plan = () => prunedInstallPlan(fixtureLock(), { workspacePath: 'apps/app', packages: ['ext-a', 'ext-b'] })

  async function installed(packages: Record<string, string>): Promise<string> {
    const nodeModules = join(await mkdtemp(join(tmpdir(), 'pruned-lockfile-')), 'node_modules')
    for (const [path, id] of Object.entries(packages)) {
      const at = id.lastIndexOf('@')
      await write(
        join(nodeModules, path, 'package.json'),
        JSON.stringify({ name: id.slice(0, at), version: id.slice(at + 1) })
      )
    }
    await mkdir(join(nodeModules, '.bin'), { recursive: true })
    return nodeModules
  }

  const matching = {
    '@scope/shared': '@scope/shared@1.2.3',
    dep: 'dep@1.0.0',
    'ext-a': 'ext-a@2.1.0',
    'ext-a/node_modules/dep': 'dep@2.0.0',
    'ext-b': 'ext-b@2.0.0',
    'peer-req': 'peer-req@1.0.0',
  }

  it('lists nested and scoped packages and accepts a tree of locked versions (a skipped platform optional is fine)', async () => {
    const list = await listInstalledPackages(await installed(matching))
    expect(list.map((pkg) => `${pkg.path} ${pkg.name}@${pkg.version}`).sort()).toEqual([
      '@scope/shared @scope/shared@1.2.3',
      'dep dep@1.0.0',
      'ext-a ext-a@2.1.0',
      'ext-a/dep dep@2.0.0',
      'ext-b ext-b@2.0.0',
      'peer-req peer-req@1.0.0',
    ])
    expect(() => assertInstalledMatchesLock(list, plan())).not.toThrow()
  })

  it('rejects a version bun.lock does not pin, naming where it was installed', async () => {
    const list = await listInstalledPackages(await installed({ ...matching, 'ext-a/node_modules/dep': 'dep@2.0.1' }))
    expect(() => assertInstalledMatchesLock(list, plan())).toThrow(/node_modules\/ext-a\/dep is dep@2\.0\.1/)
  })

  it('rejects an external that is missing or installed at another version', async () => {
    const { 'ext-a': _dropped, ...withoutA } = matching
    expect(() => assertInstalledMatchesLock([], plan())).toThrow(/runtime external ext-a is missing/)
    const list = await listInstalledPackages(await installed({ ...withoutA, 'ext-a': 'ext-a@2.0.0' }))
    expect(() => assertInstalledMatchesLock(list, plan())).toThrow(
      /ext-a installed as ext-a@2\.0\.0, but bun\.lock pins ext-a@2\.1\.0/
    )
  })
})
