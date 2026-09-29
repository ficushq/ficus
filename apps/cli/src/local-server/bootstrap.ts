import { existsSync, readdirSync, readFileSync, statSync } from 'fs'
import { join, resolve } from 'path'
import { SetupOptionsError } from './options'
import type { Runner } from './runner'
import { isCheckout } from './state'

export const DEFAULT_REPO = 'https://github.com/ficushq/tau.git'
export const defaultInstallDir = (home: string) => join(home, '.tau', 'tau')

export interface BootstrapDeps {
  runner: Runner
  which(cmd: string): string | null
  env: Record<string, string | undefined>
  home: string
  log(line: string): void
  /** Effective uid; root skips sudo when installing prerequisites. Defaults to the process's. */
  uid?: number
}

const UNZIP_HINT = 'install it (Debian/Ubuntu: sudo apt install unzip) and re-run.'

/**
 * Bun's installer needs unzip, which stock Ubuntu and Debian images ship
 * without. On an apt host where we can act as root — we ARE root, or sudo
 * works without a prompt — install it rather than telling the operator to
 * do the one command we could run ourselves. Anything else returns false and
 * the caller keeps its "install it and re-run" message.
 */
async function tryInstallUnzip(deps: BootstrapDeps, env: Record<string, string | undefined>): Promise<boolean> {
  if (!deps.which('apt-get')) return false
  const uid = deps.uid ?? process.getuid?.() ?? -1
  let prefix: string[] = []
  if (uid !== 0) {
    if (!deps.which('sudo')) return false
    const probe = await deps.runner(['sudo', '-n', 'true'], { env })
    if (probe.code !== 0) return false
    prefix = ['sudo', '-n']
  }
  deps.log("unzip is missing (Bun's installer needs it) — installing it with apt-get")
  const aptEnv = { ...env, DEBIAN_FRONTEND: 'noninteractive' }
  const install = await deps.runner([...prefix, 'apt-get', 'install', '-y', '-q', 'unzip'], {
    inherit: true,
    env: aptEnv,
  })
  if (install.code !== 0) {
    // A stale package index is the usual reason on a fresh image; refresh once.
    await deps.runner([...prefix, 'apt-get', 'update', '-q'], { inherit: true, env: aptEnv })
    const retry = await deps.runner([...prefix, 'apt-get', 'install', '-y', '-q', 'unzip'], {
      inherit: true,
      env: aptEnv,
    })
    if (retry.code !== 0) return false
  }
  return deps.which('unzip') !== null
}

export interface BootstrapOptions {
  root: string
  repo: string
  ref: string
  /** Forwarded verbatim to the checkout's `bun run setup`. */
  setupArgs: string[]
}

/**
 * The compiled CLI only bootstraps: bun + git + clone + deps. Setup itself is
 * the CHECKOUT's `bun run setup`, so this binary can never run installer logic
 * that does not match the code it is installing.
 */
export async function bootstrap(options: BootstrapOptions, deps: BootstrapDeps): Promise<void> {
  if (!deps.which('git')) throw new Error('git is required (https://git-scm.com) — install it and re-run.')

  let env: Record<string, string | undefined> = { ...deps.env }
  const { root } = options
  if (isCheckout(root)) {
    deps.log(`Using existing checkout ${root}`)
  } else if (existsSync(root) && (!statSync(root).isDirectory() || readdirSync(root).length > 0)) {
    throw new Error(`${root} exists and is not a Ficus checkout — choose another --root or remove it.`)
  } else {
    deps.log(`Cloning ${options.repo} (${options.ref}) into ${root}`)
    const r = await deps.runner(['git', 'clone', '--recurse-submodules', '--branch', options.ref, options.repo, root], {
      inherit: true,
      env,
    })
    if (r.code !== 0) throw new Error('git clone failed')
  }

  const pinFile = join(root, '.bun-version')
  if (!existsSync(pinFile))
    throw new Error(`Checkout is missing ${pinFile}; cannot determine the required Bun version.`)
  const version = readFileSync(pinFile, 'utf8').trim()
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`Invalid Bun version in ${pinFile}: expected an exact version such as 1.3.8.`)
  }

  // Probe the executable on PATH, not Bun.version: a compiled CLI embeds its
  // own runtime, which may differ from the checkout's required version.
  let bun = 'bun'
  const current = deps.which('bun') ? await deps.runner([bun, '--version'], { env }) : null
  if (current?.code !== 0 || current.stdout.trim() !== version) {
    if (!deps.which('unzip') && !(await tryInstallUnzip(deps, env))) {
      throw new Error(`Bun ${version} must be installed and its installer needs unzip — ${UNZIP_HINT}`)
    }
    for (const command of ['curl', 'bash']) {
      if (!deps.which(command))
        throw new Error(`${command} is required to install Bun ${version} — install it and re-run.`)
    }
    const installDir = resolve(env.BUN_INSTALL || join(deps.home, '.bun'))
    env = { ...env, BUN_INSTALL: installDir, PATH: [join(installDir, 'bin'), env.PATH].filter(Boolean).join(':') }
    deps.log(`Installing Bun ${version} required by the checkout (https://bun.sh)`)
    const result = await deps.runner(
      [
        'bash',
        '-o',
        'pipefail',
        '-c',
        'curl -fsSL https://bun.sh/install | bash -s -- "$1"',
        'ficus-bun-bootstrap',
        `bun-v${version}`,
      ],
      { inherit: true, env }
    )
    if (result.code !== 0) throw new Error(`Bun ${version} installation failed`)
    // Use the installed binary explicitly even if another Bun shadows it.
    bun = join(installDir, 'bin', 'bun')
    const installed = await deps.runner([bun, '--version'], { env })
    if (installed.code !== 0 || installed.stdout.trim() !== version) {
      throw new Error(`Bun version verification failed: expected ${version} at ${bun}.`)
    }
  }

  deps.log('Installing dependencies')
  const install = await deps.runner([bun, 'install', '--frozen-lockfile'], { cwd: root, inherit: true, env })
  if (install.code !== 0) throw new Error('bun install failed')

  deps.log('Handing off to the checkout: bun run setup')
  // Pass --root explicitly: setup resolves its root from cwd, and an inherited
  // FICUS_SERVER_ROOT (or a future resolution change) must not retarget the
  // checkout we just cloned.
  const setup = await deps.runner([bun, 'run', 'setup', '--', '--root', root, ...options.setupArgs], {
    cwd: root,
    inherit: true,
    env,
  })
  if (setup.code !== 0) throw new SetupOptionsError(`setup exited with ${setup.code}`, setup.code)
}
