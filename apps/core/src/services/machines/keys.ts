import { randomUUID } from 'crypto'
import { unlinkSync } from 'fs'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { getHomeDir } from '../../lib/utils/home'
import { getSecretStore } from '../secrets'

/**
 * SSH keypair generation and materialization, shared by machines and remote
 * hosts.
 *
 * Private keys are never written to disk at rest — they live only in the
 * secret store (namespaced `machine-ssh:<machineId>` / `remote-host-ssh:<hostId>`),
 * encrypted like any other secret. `materializePrivateKey` writes a scratch
 * copy to disk (0600, under a 0700 directory) only for the duration an SSH
 * client needs a key file, and callers must invoke the returned `cleanup()`
 * when done.
 */

function machineSecretKey(machineId: string): string {
  return `machine-ssh:${machineId}`
}

function remoteHostSecretKey(hostId: string): string {
  return `remote-host-ssh:${hostId}`
}

function keysScratchDir(): string {
  return join(getHomeDir(), 'machines', 'keys')
}

/**
 * Generate a fresh ed25519 keypair via `ssh-keygen`, store the private key in
 * the secret store under `secretKey`, and return the public key plus the
 * secret store key it was stored under (to persist on the owning row as
 * `sshKeyId`).
 */
export async function generateSshKeypair(
  secretKey: string,
  comment: string
): Promise<{ publicKey: string; secretKeyId: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'ficus-machine-keygen-'))
  const keyPath = join(dir, 'id_ed25519')

  try {
    const proc = Bun.spawn(['ssh-keygen', '-t', 'ed25519', '-N', '', '-C', comment, '-f', keyPath], {
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const exitCode = await proc.exited
    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text()
      throw new Error(`ssh-keygen failed (exit ${exitCode}): ${stderr.trim()}`)
    }

    const [privateKey, publicKey] = await Promise.all([readFile(keyPath, 'utf-8'), readFile(`${keyPath}.pub`, 'utf-8')])

    await getSecretStore().set(secretKey, privateKey, 'system')

    return { publicKey: publicKey.trim(), secretKeyId: secretKey }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/**
 * Generate a fresh ed25519 keypair for a machine, store the private key in
 * the secret store, and return the public key plus the secret store key it
 * was stored under (to persist on the `machines` row as `sshKeyId`).
 */
export async function generateMachineKeypair(machineId: string): Promise<{ publicKey: string; secretKeyId: string }> {
  return generateSshKeypair(machineSecretKey(machineId), `ficus-machine-${machineId}`)
}

/**
 * Generate a fresh ed25519 keypair for a remote host, store the private key
 * in the secret store, and return the public key plus the secret store key
 * it was stored under (to persist on the `remote_hosts` row as `sshKeyId`).
 */
export async function generateRemoteHostKeypair(hostId: string): Promise<{ publicKey: string; secretKeyId: string }> {
  return generateSshKeypair(remoteHostSecretKey(hostId), `ficus-remote-host-${hostId}`)
}

/**
 * Write a machine's or remote host's private key to a scratch file on disk
 * so an SSH client (e.g. Task 3's `sshExec`) can use it as an identity file.
 * Returns the path and a synchronous `cleanup()` that removes the scratch
 * file — callers must always call it (e.g. in a `finally`).
 */
export async function materializePrivateKey(owner: {
  id: string
  sshKeyId: string
}): Promise<{ path: string; cleanup: () => void }> {
  const privateKey = getSecretStore().get(owner.sshKeyId)
  if (!privateKey) {
    // `owner.sshKeyId` (not `owner.id`) disambiguates — this helper is shared by
    // machines (`machine-ssh:<id>`) and remote hosts (`remote-host-ssh:<id>`), so
    // "machine" alone would mislabel a remote-host caller. Callers that expose
    // this message externally (e.g. routes/remote-hosts.ts's probeHost) must map
    // it to a generic message rather than leak the secret-store handle.
    throw new Error(`no private key stored (secret '${owner.sshKeyId}')`)
  }

  const dir = keysScratchDir()
  await mkdir(dir, { recursive: true, mode: 0o700 })
  await chmod(dir, 0o700)

  const path = join(dir, `${owner.id}-${randomUUID()}`)
  await writeFile(path, privateKey, { mode: 0o600 })
  await chmod(path, 0o600)

  return {
    path,
    cleanup: () => {
      try {
        unlinkSync(path)
      } catch {
        // Best-effort — scratch file, not load-bearing if removal fails.
      }
    },
  }
}
