import type { ManagedToolchainRequest } from '../types'
import { type BashResponse, SandboxClient, SandboxHttpError, SandboxTransportError } from '../client/http-client'
import { ToolchainAdapterError } from './provision'

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
    await run(client, `devbox install -c ${quote(dir)}`, workRoot, 'install_failed')
    if (config.setupScript) {
      await request.reportStage('running_setup')
      await run(client, `devbox run -c ${quote(dir)} -- bash ${quote(`${dir}/setup.sh`)}`, workRoot, 'setup_failed')
    }
    await runReadiness(client, dir, workRoot, request.readiness)
    await signalToolchainReady(client, true, fingerprint)
    await write(client, `${dir}/.ready`, `${fingerprint}\n`)
    return 'applied' as const
  })
}
