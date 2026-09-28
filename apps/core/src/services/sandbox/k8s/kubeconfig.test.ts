import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

/**
 * loadKubeConfig()'s local-dev branch sets NODE_TLS_REJECT_UNAUTHORIZED=0 for
 * the WHOLE process, and its IS_LOCAL_DEV is captured at module load — so the
 * gate can only be exercised in a fresh process (an in-process env mutation
 * cannot change an already-evaluated const).
 *
 * The child gets an empty HOME and no KUBECONFIG so loadFromDefault falls
 * through to its localhost:8080 default: no cluster, no kubeconfig file, and
 * no dependence on the host's kubectl setup. cwd is an empty temp dir because
 * bun auto-loads ./.env before user code.
 *
 * Bun drops empty-string env values, so passing '' for KUBECONFIG /
 * NODE_TLS_REJECT_UNAUTHORIZED leaves them UNSET in the child — which is why
 * "not downgraded" reads as null here.
 */
function tlsRejectAfterLoadKubeConfig(env: Record<string, string>): unknown {
  const dir = mkdtempSync(join(tmpdir(), 'tau-k8s-kubeconfig-'))
  try {
    const result = Bun.spawnSync(
      [
        process.execPath,
        '-e',
        `const m = await import(${JSON.stringify(join(__dirname, 'kubeconfig.ts'))})
         m.loadKubeConfig()
         console.log(JSON.stringify(process.env.NODE_TLS_REJECT_UNAUTHORIZED ?? null))`,
      ],
      {
        cwd: dir,
        env: { ...process.env, HOME: dir, KUBECONFIG: '', NODE_TLS_REJECT_UNAUTHORIZED: '', ...env },
        stdout: 'pipe',
        stderr: 'pipe',
      }
    )
    expect({ code: result.exitCode, stderr: result.stderr.toString() }).toEqual({ code: 0, stderr: '' })
    return JSON.parse(result.stdout.toString().trim())
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('loadKubeConfig TLS downgrade (module-load gate)', () => {
  test('a stale FICUS_K8S_LOCAL under another runtime never disables TLS verification', () => {
    // This is the whole point of gating the k8s modules: the downgrade is
    // process-wide, so a leftover k3d line in a host install's .env must not
    // reach it.
    expect(tlsRejectAfterLoadKubeConfig({ FICUS_SANDBOX_RUNTIME: 'host', FICUS_K8S_LOCAL: 'true' })).toBeNull()
    expect(tlsRejectAfterLoadKubeConfig({ FICUS_SANDBOX_RUNTIME: 'vm', FICUS_K8S_LOCAL: 'true' })).toBeNull()
  })

  test('local k3d (k8s + FICUS_K8S_LOCAL=true) still disables TLS verification', () => {
    expect(tlsRejectAfterLoadKubeConfig({ FICUS_SANDBOX_RUNTIME: 'k8s', FICUS_K8S_LOCAL: 'true' })).toBe('0')
    expect(tlsRejectAfterLoadKubeConfig({ FICUS_SANDBOX_RUNTIME: 'k8s' })).toBeNull()
  })
})
