import { afterEach, beforeEach, describe, it, expect } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { detectDeploymentFlavor, resolveRepoRoot, supportsAutoUpdate } from './deployment-flavor'

describe('detectDeploymentFlavor', () => {
  it('detects pm2 from pm2 child env', () => {
    const f = detectDeploymentFlavor({ repoRoot: process.cwd(), env: { pm_id: '0' } })
    expect(f.supervisor).toBe('pm2')
  })

  it('detects systemd from INVOCATION_ID', () => {
    const f = detectDeploymentFlavor({ repoRoot: process.cwd(), env: { INVOCATION_ID: 'abc' } })
    expect(f.supervisor).toBe('systemd')
  })

  it('env override wins over ambient signals and ignores invalid values', () => {
    expect(detectDeploymentFlavor({ env: { FICUS_UPDATE_SUPERVISOR: 'systemd', pm_id: '0' } }).supervisor).toBe(
      'systemd'
    )
    expect(detectDeploymentFlavor({ env: { FICUS_UPDATE_SUPERVISOR: 'launchd' } }).supervisor).toBe('launchd')
    expect(detectDeploymentFlavor({ env: { FICUS_UPDATE_SUPERVISOR: 'systemd-user' } }).supervisor).toBe('systemd-user')
  })

  it('maps sandbox runtime envs', () => {
    // k3d-local — the one flavor whose sandbox image is rebuilt/imported
    // locally (bun run k3d:import) — is the k8s runtime PLUS FICUS_K8S_LOCAL.
    expect(
      detectDeploymentFlavor({ env: { FICUS_SANDBOX_RUNTIME: 'k8s', FICUS_K8S_LOCAL: 'true' } }).sandboxRuntime
    ).toBe('k3d-local')
    // FICUS_K8S_LOCAL on its own names no runtime the core would boot on, so it
    // labels nothing (it used to short-circuit to k3d-local before the runtime
    // was even read).
    expect(detectDeploymentFlavor({ env: { FICUS_K8S_LOCAL: 'true' } }).sandboxRuntime).toBe('other')
    // A plain k8s server (toolkit runtime.sandbox=k8s) pulls images from a
    // registry — it must NOT be treated as k3d-local or it would get k3d tasks.
    expect(detectDeploymentFlavor({ env: { FICUS_SANDBOX_RUNTIME: 'k8s' } }).sandboxRuntime).toBe('k8s')
    expect(detectDeploymentFlavor({ env: { FICUS_SANDBOX_RUNTIME: 'vm' } }).sandboxRuntime).toBe('vm')
    expect(detectDeploymentFlavor({ env: { FICUS_SANDBOX_RUNTIME: 'docker-sysbox' } }).sandboxRuntime).toBe(
      'docker-sysbox'
    )
    expect(detectDeploymentFlavor({ env: { FICUS_SANDBOX_RUNTIME: 'docker-socket' } }).sandboxRuntime).toBe(
      'docker-socket'
    )
    // The removed spellings are no longer runtimes at all — they are unlabelled.
    expect(detectDeploymentFlavor({ env: { FICUS_SANDBOX_RUNTIME: 'docker' } }).sandboxRuntime).toBe('other')
    expect(detectDeploymentFlavor({ env: { FICUS_SANDBOX_RUNTIME: 'auto' } }).sandboxRuntime).toBe('other')
    expect(detectDeploymentFlavor({ env: {} }).sandboxRuntime).toBe('other')
  })

  it('labels FICUS_SANDBOX_RUNTIME=host as the host flavor', () => {
    expect(detectDeploymentFlavor({ env: { FICUS_SANDBOX_RUNTIME: 'host' } }).sandboxRuntime).toBe('host')
  })

  it('ignores a stale FICUS_K8S_LOCAL under another runtime (regression)', () => {
    // An operator moved a local k3d checkout to FICUS_SANDBOX_RUNTIME=host and
    // left FICUS_K8S_LOCAL=true in .env. FICUS_K8S_LOCAL used to be read BEFORE the
    // runtime, so the install stayed labelled k3d-local and the in-app updater
    // planned `bun run k3d:import` on every update. The runtime decides.
    expect(
      detectDeploymentFlavor({ env: { FICUS_SANDBOX_RUNTIME: 'host', FICUS_K8S_LOCAL: 'true' } }).sandboxRuntime
    ).toBe('host')
    expect(
      detectDeploymentFlavor({ env: { FICUS_SANDBOX_RUNTIME: 'docker-sysbox', FICUS_K8S_LOCAL: 'true' } })
        .sandboxRuntime
    ).toBe('docker-sysbox')
    expect(
      detectDeploymentFlavor({ env: { FICUS_SANDBOX_RUNTIME: 'vm', FICUS_K8S_LOCAL: 'true' } }).sandboxRuntime
    ).toBe('vm')
  })

  it('trims whitespace around FICUS_SANDBOX_RUNTIME before matching, like the boot guard', () => {
    // A stray .env/shell newline can pad the value (' host '); the boot guard
    // (requireSandboxRuntime) trims before comparing, so this label must too or
    // it silently reports 'other' for a runtime that actually booted.
    expect(detectDeploymentFlavor({ env: { FICUS_SANDBOX_RUNTIME: ' host ' } }).sandboxRuntime).toBe('host')
  })

  it('detects git-checkout source from a .git directory', () => {
    // The monorepo checkout running the tests is itself a git checkout.
    expect(detectDeploymentFlavor({ repoRoot: findRepoRoot(), env: {} }).source).toBe('git-checkout')
    expect(detectDeploymentFlavor({ repoRoot: '/tmp', env: {} }).source).toBe('unknown')
  })

  it('resolves the repo root by walking up from a nested cwd (systemd WorkingDirectory)', () => {
    // The merged systemd units set WorkingDirectory=<dest>/apps/core while the
    // git checkout root is <dest>. A cwd-only check at apps/core would see no
    // .git and gate the updater off; detection must walk up to the real root.
    const tmp = mkdtempSync(join(tmpdir(), 'tau-flavor-'))
    const repo = join(tmp, 'repo')
    const nested = join(repo, 'apps', 'core')
    mkdirSync(join(repo, '.git'), { recursive: true })
    mkdirSync(nested, { recursive: true })
    try {
      expect(resolveRepoRoot(nested)).toBe(repo)
      expect(detectDeploymentFlavor({ cwd: nested, env: {} }).source).toBe('git-checkout')
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})

describe('detectDeploymentFlavor artifact mode', () => {
  let tmp: string
  const SHA = 'c'.repeat(40)

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'tau-flavor-artifact-'))
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  it('source is "artifact" with a valid 40-hex commit in artifact.json', () => {
    writeFileSync(join(tmp, 'artifact.json'), JSON.stringify({ commit: SHA }))
    expect(detectDeploymentFlavor({ artifactRoot: tmp, env: {} }).source).toBe('artifact')
  })

  it('malformed artifact.json (invalid JSON) → source "unknown", never throws', () => {
    writeFileSync(join(tmp, 'artifact.json'), '{not json')
    expect(() => detectDeploymentFlavor({ artifactRoot: tmp, env: {} })).not.toThrow()
    expect(detectDeploymentFlavor({ artifactRoot: tmp, env: {} }).source).toBe('unknown')
  })

  it('artifact.json missing/invalid commit → source "unknown"', () => {
    writeFileSync(join(tmp, 'artifact.json'), JSON.stringify({ commit: 'not-a-sha' }))
    expect(detectDeploymentFlavor({ artifactRoot: tmp, env: {} }).source).toBe('unknown')
  })

  it('artifact detection wins over a repoRoot that is a real git checkout', () => {
    writeFileSync(join(tmp, 'artifact.json'), JSON.stringify({ commit: SHA }))
    const f = detectDeploymentFlavor({ artifactRoot: tmp, repoRoot: findRepoRoot(), env: {} })
    expect(f.source).toBe('artifact')
  })

  it('git-checkout detection is unchanged when artifactRoot has no artifact.json', () => {
    const f = detectDeploymentFlavor({ artifactRoot: tmp, repoRoot: findRepoRoot(), env: {} })
    expect(f.source).toBe('git-checkout')
  })
})

describe('supportsAutoUpdate', () => {
  it('accepts git checkout with a known supervisor', () => {
    expect(supportsAutoUpdate({ source: 'git-checkout', supervisor: 'pm2', sandboxRuntime: 'k3d-local' }).ok).toBe(true)
    expect(
      supportsAutoUpdate({ source: 'git-checkout', supervisor: 'systemd', sandboxRuntime: 'docker-socket' }).ok
    ).toBe(true)
  })

  it('rejects non-git sources and unknown supervisors with reasons', () => {
    const noGit = supportsAutoUpdate({ source: 'unknown', supervisor: 'pm2', sandboxRuntime: 'other' })
    expect(noGit.ok).toBe(false)
    expect(noGit.reason).toContain('git checkout')
    const noSup = supportsAutoUpdate({ source: 'git-checkout', supervisor: 'unknown', sandboxRuntime: 'other' })
    expect(noSup.ok).toBe(false)
    expect(noSup.reason).toContain('FICUS_UPDATE_SUPERVISOR')
  })

  it('rejects an artifact deployment with a control-plane-specific reason', () => {
    const r = supportsAutoUpdate({ source: 'artifact', supervisor: 'systemd', sandboxRuntime: 'vm' })
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('prebuilt release artifact')
    expect(r.reason).toContain('control plane')
  })
})

function findRepoRoot(): string {
  // apps/core cwd during tests → repo root is two levels up when .git exists there.
  let dir = process.cwd()
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, '.git'))) return dir
    dir = dirname(dir)
  }
  return process.cwd()
}

it('desktop-owned runtimes cannot invoke the checkout updater', () => {
  const flavor = detectDeploymentFlavor({ repoRoot: findRepoRoot(), env: { FICUS_DESKTOP_MANAGED: '1', pm_id: '0' } })
  expect(flavor.supervisor).toBe('desktop')
  expect(supportsAutoUpdate(flavor)).toEqual({
    ok: false,
    reason: 'This instance is managed by Ficus Desktop. Update it through the desktop application.',
  })
})
