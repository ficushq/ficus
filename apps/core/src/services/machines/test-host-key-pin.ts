import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { HostKeyPin } from '../ssh-trust/args'

/**
 * For the GATED real-host integration tests only (the operator's own disposable
 * test host named by env): pins whatever keys `ssh-keyscan` returns now. Never
 * used by Core itself, where keys are confirmed by a person (services/ssh-trust).
 */
export async function keyscanPinForTest(host: string, port: number): Promise<HostKeyPin> {
  const proc = Bun.spawn(['ssh-keyscan', '-T', '10', '-p', String(port), host], { stdout: 'pipe', stderr: 'ignore' })
  const out = await new Response(proc.stdout).text()
  await proc.exited
  const alias = 'ficus-trust.integration-test'
  const lines = out
    .split('\n')
    .filter((l) => l.trim() && !l.startsWith('#'))
    .map((l) => `${alias} ${l.split(/\s+/).slice(1, 3).join(' ')}\n`)
  if (!lines.length) throw new Error(`ssh-keyscan returned no host key for ${host}:${port}`)
  const knownHostsPath = join(mkdtempSync(join(tmpdir(), 'ficus-test-pin-')), 'known_hosts')
  writeFileSync(knownHostsPath, lines.join(''), { mode: 0o600 })
  return { knownHostsPath, alias }
}

/** Per-host cached {@link keyscanPinForTest}, shaped as a machine pin resolver (gated tests only). */
export function keyscanPinResolverForTest(): (machine: { sshHost: string; sshPort: number }) => Promise<HostKeyPin> {
  const cache = new Map<string, Promise<HostKeyPin>>()
  return (machine) => {
    const id = `${machine.sshHost}:${machine.sshPort}`
    let pin = cache.get(id)
    if (!pin) {
      pin = keyscanPinForTest(machine.sshHost, machine.sshPort)
      cache.set(id, pin)
    }
    return pin
  }
}

/**
 * Gated tests that drive the real routes: fetch the endpoint's keys and trust
 * every pending one as `userId`, standing in for the person who would compare
 * fingerprints in Settings.
 */
export async function trustFetchedHostKeysForTest(
  spec: import('../ssh-trust').TrustTargetSpec,
  userId: string
): Promise<void> {
  const { ensureTrustTarget, listTrustKeys, refreshTrustTarget, trustTrustKey } = await import('../ssh-trust')
  const target = await ensureTrustTarget(spec)
  await refreshTrustTarget(target)
  for (const key of await listTrustKeys(target.id)) {
    if (key.status === 'pending') await trustTrustKey(target.id, key.id, userId)
  }
}
