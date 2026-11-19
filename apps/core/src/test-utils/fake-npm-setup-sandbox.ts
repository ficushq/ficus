import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runCapturedProcess, type ProcessOutcome } from './captured-process'

/**
 * A throwaway directory tree for running an integration setup script with a
 * fake `npm`, so integrity checks can be exercised without the network.
 *
 * `npm pack` writes `tarball` into the current directory and prints its name;
 * `npm install` records its arguments and replaces the installed binary. A
 * pre-existing binary is planted first, so a test can prove a rejected archive
 * left it untouched.
 */
export interface FakeNpmSetupSandbox {
  /** Run `script` with bash, as the toolchain adapters run setup.sh. */
  run(script: string): Promise<ProcessOutcome>
  /** Arguments of every `npm install` call, one line each. */
  installs(): string[]
  /** Content of `$DEVBOX_PROJECT_ROOT/npm/bin/<binary>`. */
  installedBinary(): string
  /** Entries left in TMPDIR and in the working directory after the run. */
  leftovers(): { temp: string[]; work: string[] }
  /** Absolute path of a file in the sandbox root, for marker files written by a script. */
  path(name: string): string
  exists(name: string): boolean
  dispose(): void
}

export const ORIGINAL_BINARY = 'original-cli'
export const INSTALLED_BINARY = 'installed-cli'

export function sha512Base64(content: string): string {
  return createHash('sha512').update(content).digest('base64')
}

export function createFakeNpmSetupSandbox(binary: string, tarball: string): FakeNpmSetupSandbox {
  const root = mkdtempSync(join(tmpdir(), 'integration-setup-'))
  const bin = join(root, 'bin')
  const temp = join(root, 'tmp')
  const work = join(root, 'work')
  const project = join(root, 'project')
  const installLog = join(root, 'npm-install.log')
  for (const path of [bin, temp, work, join(project, 'npm/bin')]) mkdirSync(path, { recursive: true })
  writeFileSync(join(project, 'npm/bin', binary), ORIGINAL_BINARY)
  writeFileSync(join(root, 'tarball'), tarball)
  writeFileSync(join(bin, 'node'), `#!/bin/sh\nexec '${process.execPath}' "$@"\n`, { mode: 0o755 })
  writeFileSync(
    join(bin, 'npm'),
    [
      '#!/bin/sh',
      'case "$1" in',
      `  pack) cp '${join(root, 'tarball')}' fixture.tgz; printf 'fixture.tgz\\n' ;;`,
      `  install) printf '%s\\n' "$*" >> '${installLog}'; printf '${INSTALLED_BINARY}' > "$DEVBOX_PROJECT_ROOT/npm/bin/${binary}" ;;`,
      '  *) exit 99 ;;',
      'esac',
      '',
    ].join('\n'),
    { mode: 0o755 }
  )

  return {
    run: (script) =>
      runCapturedProcess(['bash', '-c', script], {
        cwd: work,
        env: { HOME: root, TMPDIR: temp, PATH: `${bin}:/usr/bin:/bin`, DEVBOX_PROJECT_ROOT: project },
        timeoutMs: 10_000,
      }),
    installs: () => (existsSync(installLog) ? readFileSync(installLog, 'utf8').trim().split('\n') : []),
    installedBinary: () => readFileSync(join(project, 'npm/bin', binary), 'utf8'),
    leftovers: () => ({ temp: readdirSync(temp), work: readdirSync(work) }),
    path: (name) => join(root, name),
    exists: (name) => existsSync(join(root, name)),
    dispose: () => rmSync(root, { recursive: true, force: true }),
  }
}
