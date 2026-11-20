import type { ManagedToolchainRequest } from '../types'
import { type BashResponse, SandboxClient, SandboxHttpError, SandboxTransportError } from '../client/http-client'
import { ToolchainAdapterError } from './provision'
import { withNixCacheMaintenance } from '../../machines/nix-cache-maintenance'
import { createLogger } from '../../../lib/infra/logger'

const log = createLogger('toolchain')

function quote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

async function run(
  client: SandboxClient,
  command: string,
  cwd: string,
  failure: 'install_failed' | 'setup_failed' | 'activation_failed' | 'readiness_failed'
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let exitCode: number | undefined
    let timedOut = false
    const stream = client.bash({ command, cwd, timeoutSeconds: 600, sourceEnv: true, activateDevbox: false })
    stream.on('data', (response: BashResponse) => {
      if (response.exitCode !== undefined) exitCode = response.exitCode
      if (response.error && /timed? out|timeout/i.test(response.error)) timedOut = true
    })
    stream.on('error', () => reject(new ToolchainAdapterError(failure)))
    stream.on('end', () => {
      if (exitCode === 0) resolve()
      else if (timedOut) reject(new ToolchainAdapterError('timeout'))
      else reject(new ToolchainAdapterError(failure, exitCode))
    })
  })
}

async function runReadiness(
  client: SandboxClient,
  dir: string,
  workRoot: string,
  checks: ManagedToolchainRequest['readiness']
): Promise<void> {
  for (const check of checks ?? []) {
    const command = `set -o pipefail; ${check.command} | grep -F -- ${quote(check.expectedSubstring)}`
    await run(client, `devbox run -c ${quote(dir)} -- bash -lc ${quote(command)}`, workRoot, 'readiness_failed')
  }
}

/**
 * Confirm the box server's managed toolchain activation. A failure here was
 * previously surfaced as an unclassified error; name it so an overloaded box
 * reads as a timeout rather than an unknown provisioning failure.
 */
async function signalToolchainReady(client: SandboxClient, active: boolean, fingerprint?: string): Promise<void> {
  try {
    await client.toolchainReady(active, fingerprint)
  } catch (error) {
    const timedOut =
      (error instanceof SandboxTransportError && error.kind === 'timeout') ||
      (error instanceof SandboxHttpError && (error.status === 504 || error.code === 'timeout'))
    throw new ToolchainAdapterError(timedOut ? 'timeout' : 'activation_failed', undefined, error)
  }
}

async function readMarker(client: SandboxClient, dir: string): Promise<string> {
  try {
    const response = await client.read({ path: `${dir}/.ready` })
    return Buffer.from(response.content, 'base64').toString('utf8').trim()
  } catch {
    return ''
  }
}

async function write(client: SandboxClient, path: string, contents: string, mode?: string): Promise<void> {
  await client.write({ path, content: Buffer.from(contents).toString('base64'), createDirs: true, mode })
}

async function readResolvedLock(client: SandboxClient, dir: string): Promise<string | undefined> {
  try {
    const response = await client.read({ path: `${dir}/devbox.lock` })
    const content = Buffer.from(response.content, 'base64').toString('utf8')
    return content.trim() ? content : undefined
  } catch {
    return undefined
  }
}

/**
 * Install the managed Devbox, from the squad's pinned lock when there is one.
 *
 * A pinned install reuses a nixpkgs commit earlier boxes already realized, so
 * it skips downloading the current nixpkgs tip. If it fails (the pin cannot be
 * realized here), the box falls back to a fresh resolution, exactly as it
 * would without a pin. A fresh resolution always starts without a lock: a
 * changed configuration resolves `@latest` again, and a lock left in the
 * directory cannot leak into the one Ficus records. A timeout is not retried;
 * it fails the reconcile like any other install timeout.
 *
 * Returns the freshly resolved lock (read before the setup script runs), or
 * undefined when the pin was used or the lock could not be read.
 */
async function installManagedDevbox(
  client: SandboxClient,
  dir: string,
  workRoot: string,
  pinnedLock: string | undefined
): Promise<{ resolvedLock?: string; unrealizable: boolean }> {
  const lockPath = `${dir}/devbox.lock`
  const install = () =>
    run(client, withNixCacheMaintenance(`devbox install -c ${quote(dir)}`), workRoot, 'install_failed')
  if (pinnedLock !== undefined) {
    try {
      await write(client, lockPath, pinnedLock)
      await install()
      return { unrealizable: false }
    } catch (error) {
      if (error instanceof ToolchainAdapterError && error.code === 'timeout') throw error
      log.warn(`Pinned toolchain lock did not install in ${dir}; resolving afresh`, error)
    }
  }
  await run(client, `rm -f ${quote(lockPath)}`, workRoot, 'install_failed')
  await install()
  return { resolvedLock: await readResolvedLock(client, dir), unrealizable: pinnedLock !== undefined }
}

export async function reconcileRemoteToolchain(
  client: SandboxClient,
  dir: string,
  workRoot: string,
  request: ManagedToolchainRequest,
  trackSetupWork: <T>(operation: () => Promise<T>) => Promise<T> = (operation) => operation()
): Promise<'unchanged' | 'applied' | 'cleared'> {
  if (!request.config || !request.fingerprint || !request.devboxJson) {
    return trackSetupWork(async () => {
      await run(client, `rm -f ${quote(`${dir}/.ready`)}`, workRoot, 'activation_failed')
      await signalToolchainReady(client, false)
      return 'cleared' as const
    })
  }

  const config = request.config
  const fingerprint = request.fingerprint
  const devboxJson = request.devboxJson

  if ((await readMarker(client, dir)) === fingerprint) {
    await runReadiness(client, dir, workRoot, request.readiness)
    await signalToolchainReady(client, true, fingerprint)
    return 'unchanged'
  }

  return trackSetupWork(async () => {
    await run(client, `rm -f ${quote(`${dir}/.ready`)}`, workRoot, 'activation_failed')
    await write(client, `${dir}/devbox.json`, devboxJson)
    if (config.setupScript) await write(client, `${dir}/setup.sh`, config.setupScript, '0700')
    else await run(client, `rm -f ${quote(`${dir}/setup.sh`)}`, workRoot, 'activation_failed')

    await request.reportStage('installing')
    const installed = await installManagedDevbox(client, dir, workRoot, await request.loadPinnedLock?.())
    if (config.setupScript) {
      await request.reportStage('running_setup')
      await run(client, `devbox run -c ${quote(dir)} -- bash ${quote(`${dir}/setup.sh`)}`, workRoot, 'setup_failed')
    }
    await runReadiness(client, dir, workRoot, request.readiness)
    await signalToolchainReady(client, true, fingerprint)
    await write(client, `${dir}/.ready`, `${fingerprint}\n`)
    if (installed.resolvedLock !== undefined && request.recordResolvedLock) {
      await request
        .recordResolvedLock(installed.resolvedLock, { unrealizable: installed.unrealizable })
        .catch((error: unknown) => log.warn(`Recording the resolved toolchain lock failed for ${dir}`, error))
    }
    return 'applied' as const
  })
}
