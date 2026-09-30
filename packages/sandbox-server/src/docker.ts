/**
 * Docker daemon management.
 *
 * Two runtimes, selected by whether `FICUS_BOX_HOME` is set (only vm boxes set
 * it — exactly the same gate slice-2's path rebasing uses):
 *
 *  - `sysbox` (FICUS_BOX_HOME unset — k8s pods with the sysbox RuntimeClass, and
 *    local docker): the pod can run a full rootful Docker daemon inside it
 *    without privileged mode. This module starts `dockerd` on boot if no socket
 *    is already present (socket mode) and chmods the system socket so
 *    `docker exec --user` can reach it. Byte-identical to the pre-box behavior.
 *
 *  - `rootless-box` (FICUS_BOX_HOME set — a vm box): the daemon is the box user's
 *    OWN rootless dockerd, a lingering systemd --user service started by
 *    box-provision.sh and reached via `DOCKER_HOST=unix:///run/user/<uid>/docker.sock`.
 *    On a shared multi-box VM a single rootful daemon is root-equivalent for
 *    every box user (spec §5), so this module MUST NEVER spawn a rootful dockerd
 *    or chmod the system socket here — it only VERIFIES the box's own rootless
 *    socket is ready.
 */

import { spawn, execSync } from 'child_process'

const log = (msg: string) => console.log(`[sandbox] ${msg}`)
const logError = (msg: string) => console.error(`[sandbox] ${msg}`)

let dockerBootPromise: Promise<boolean> | null = null

/**
 * Start dockerd if running under sysbox (no socket already present).
 * Memoized: repeated calls return the same in-flight/settled boot promise, so
 * `waitForDockerReady` can await the boot kicked off at server startup.
 * Returns true if Docker is available (either started or already present).
 */
export function ensureDocker(): Promise<boolean> {
  if (!dockerBootPromise) {
    dockerBootPromise = startDocker()
  }
  return dockerBootPromise
}

/**
 * Block until dockerd has finished booting, for a command that needs Docker.
 *
 * The server serves /healthz (pod-ready) before dockerd finishes its cold-start,
 * so a `docker` command issued in that early window would hit a not-yet-ready
 * daemon. This awaits the memoized boot promise (capped by timeoutMs) so the
 * first docker use waits instead of failing. No-op on agent (light) boxes —
 * they never run docker.
 *
 * Returns true if Docker is ready, false on an agent box or if the wait times
 * out / dockerd failed (the caller then runs the command and lets docker report
 * its own error).
 */
export async function waitForDockerReady(timeoutMs = 30_000): Promise<boolean> {
  if (process.env.FICUS_SANDBOX_ROLE === 'agent') return false

  let timer: ReturnType<typeof setTimeout> | undefined
  const cap = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs)
  })
  try {
    return await Promise.race([ensureDocker(), cap])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * Which docker runtime this process manages. Gated ONLY on `FICUS_BOX_HOME`
 * (set exclusively by vm boxes), so with it unset the mode is `sysbox` and the
 * startup path is byte-identical to the pre-box implementation.
 */
export function dockerRuntimeMode(): 'rootless-box' | 'sysbox' {
  return process.env.FICUS_BOX_HOME ? 'rootless-box' : 'sysbox'
}

/**
 * VM-box path: the box user's rootless dockerd is already running as its own
 * systemd --user service (box-provision.sh started it). We do NOT spawn a
 * daemon or touch any system socket — we only confirm the rootless socket named
 * by `DOCKER_HOST` is answering (`docker info` honors DOCKER_HOST), briefly
 * waiting in case the daemon is still finishing its own start.
 *
 * `isReady`/`wait` are injectable for tests; production uses the real
 * `docker info` probe. Returns false (never throws) if DOCKER_HOST is unset or
 * the socket never comes up — the caller then runs its command and lets docker
 * report its own error.
 */
export async function verifyRootlessDocker(
  opts: { isReady?: () => boolean; wait?: (timeoutMs: number) => Promise<boolean> } = {}
): Promise<boolean> {
  const isReady = opts.isReady ?? isDockerReady
  const wait = opts.wait ?? ((ms: number) => waitForDocker(ms))

  if (!process.env.DOCKER_HOST) {
    logError('FICUS_BOX_HOME is set but DOCKER_HOST is unset; rootless docker socket unknown')
    return false
  }

  if (isReady()) {
    log('Docker (rootless per-box) socket already ready')
    return true
  }

  log('Waiting for the box rootless Docker socket...')
  const ready = await wait(30_000)
  if (ready) log('Docker (rootless per-box) is ready')
  else logError('rootless Docker socket did not become ready within timeout')
  return ready
}

async function startDocker(): Promise<boolean> {
  // VM box: verify the box user's OWN rootless daemon; never spawn rootful
  // dockerd or chmod the system socket (that shared-root hole is what
  // rootless-per-box closes). Everything below this guard is the unchanged
  // sysbox path taken when FICUS_BOX_HOME is unset (k8s/local).
  if (dockerRuntimeMode() === 'rootless-box') {
    return verifyRootlessDocker()
  }

  // Clear DOCKER_HOST — docker:dind base sets it to tcp://docker:2375
  // but we need the local Unix socket
  delete process.env.DOCKER_HOST

  // Check if Docker socket already exists (socket mode / already running)
  if (isDockerReady()) {
    log('Docker socket already present (socket mode or already running)')
    return true
  }

  log('Starting dockerd (sysbox mode)...')

  const dockerd = spawn('dockerd', [], {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  })

  // Don't let dockerd keep our process alive
  dockerd.unref()

  // Track if dockerd exits (crash detection)
  let dockerdExited = false
  dockerd.on('exit', (code) => {
    dockerdExited = true
    if (code !== 0) logError(`dockerd exited with code ${code}`)
  })

  // Log dockerd output for debugging
  dockerd.stdout?.on('data', (data: Buffer) => {
    const line = data.toString().trim()
    if (line) log(`dockerd: ${line}`)
  })
  dockerd.stderr?.on('data', (data: Buffer) => {
    const line = data.toString().trim()
    if (line) log(`dockerd: ${line}`)
  })

  dockerd.on('error', (err) => {
    dockerdExited = true
    logError(`dockerd failed to start: ${err.message}`)
  })

  // Wait for Docker to be ready (up to 30s, bail early if dockerd crashes)
  const ready = await waitForDocker(30_000, () => dockerdExited)

  if (ready) {
    log('Docker is ready')

    // Make socket accessible to all users in the container.
    // docker exec --user doesn't load supplementary groups from /etc/group,
    // so users can't access the socket even if they're in the docker group.
    try {
      execSync('chmod 666 /var/run/docker.sock', { stdio: 'ignore' })
      log('Docker socket permissions updated')
    } catch {
      // Non-fatal — socket may already have correct permissions
    }
  } else {
    logError('Docker failed to start within timeout')
  }

  return ready
}

function isDockerReady(): boolean {
  try {
    execSync('docker info', { stdio: 'ignore', timeout: 5000 })
    return true
  } catch {
    return false
  }
}

async function waitForDocker(timeoutMs: number, hasCrashed?: () => boolean): Promise<boolean> {
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    if (hasCrashed?.()) {
      logError('dockerd crashed, giving up')
      return false
    }
    if (isDockerReady()) return true
    await new Promise((r) => setTimeout(r, 1000))
  }

  return false
}
