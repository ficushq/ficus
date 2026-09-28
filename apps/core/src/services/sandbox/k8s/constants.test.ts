import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

/**
 * IS_LOCAL_DEV is captured at MODULE LOAD, so no in-process env mutation can
 * exercise the gate — mutate process.env in this file and the already-imported
 * constant keeps its value, and the test passes with or without the gate.
 * Each case therefore gets a fresh process.
 *
 * cwd is an empty temp dir because bun auto-loads ./.env before user code: run
 * from the checkout, a real .env would silently outrank the env passed here.
 */
function isLocalDevInFreshProcess(env: Record<string, string>): unknown {
  const dir = mkdtempSync(join(tmpdir(), 'tau-k8s-const-'))
  try {
    const result = Bun.spawnSync(
      [
        process.execPath,
        '-e',
        `const m = await import(${JSON.stringify(join(__dirname, 'constants.ts'))})
         console.log(JSON.stringify(m.IS_LOCAL_DEV))`,
      ],
      { cwd: dir, env: { ...process.env, ...env }, stdout: 'pipe', stderr: 'pipe' }
    )
    expect({ code: result.exitCode, stderr: result.stderr.toString() }).toEqual({ code: 0, stderr: '' })
    return JSON.parse(result.stdout.toString().trim())
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('IS_LOCAL_DEV (module-load gate)', () => {
  test('a stale FICUS_K8S_LOCAL under another runtime does not enable local dev', () => {
    // The sandbox factory imports every manager eagerly, so this module is
    // evaluated on a host install too — a leftover k3d line must stay inert.
    expect(isLocalDevInFreshProcess({ FICUS_SANDBOX_RUNTIME: 'host', FICUS_K8S_LOCAL: 'true' })).toBe(false)
    expect(isLocalDevInFreshProcess({ FICUS_SANDBOX_RUNTIME: 'docker-socket', FICUS_K8S_LOCAL: 'true' })).toBe(false)
  })

  test('the k8s runtime with FICUS_K8S_LOCAL=true still enables local dev', () => {
    expect(isLocalDevInFreshProcess({ FICUS_SANDBOX_RUNTIME: 'k8s', FICUS_K8S_LOCAL: 'true' })).toBe(true)
    expect(isLocalDevInFreshProcess({ FICUS_SANDBOX_RUNTIME: 'k8s', FICUS_K8S_LOCAL: 'false' })).toBe(false)
  })
})
