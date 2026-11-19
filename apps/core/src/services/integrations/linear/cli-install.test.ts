import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runCapturedProcess } from '../../../test-utils/captured-process'
import { linearCliSetupStep } from './cli'

describe('Linear CLI installer', () => {
  /** Runs the setup step with fake uname, curl and xz in an isolated project root. */
  async function runInstaller(options: { arch: string; archive: string }) {
    const root = mkdtempSync(join(tmpdir(), 'linear-cli-install-'))
    const bin = join(root, 'bin'),
      temp = join(root, 'tmp'),
      project = join(root, 'project')
    for (const path of [bin, temp, join(project, 'npm/bin')]) mkdirSync(path, { recursive: true })
    writeFileSync(join(project, 'npm/bin/linear'), 'original-cli')
    writeFileSync(join(bin, 'node'), `#!/bin/sh\nexec '${process.execPath}' "$@"\n`, { mode: 0o755 })
    writeFileSync(join(bin, 'uname'), `#!/bin/sh\n[ "$1" = -s ] && echo Linux || echo '${options.arch}'\n`, {
      mode: 0o755,
    })
    writeFileSync(join(root, 'archive'), options.archive)
    writeFileSync(
      join(bin, 'curl'),
      `#!/bin/sh\necho called > '${join(root, 'curl-called')}'\ncp '${join(root, 'archive')}' cli.tar.xz\n`,
      { mode: 0o755 }
    )
    writeFileSync(join(bin, 'xz'), `#!/bin/sh\necho called > '${join(root, 'xz-called')}'\nexit 1\n`, { mode: 0o755 })
    try {
      const result = await runCapturedProcess(['/bin/sh', '-c', linearCliSetupStep().script], {
        env: { HOME: root, TMPDIR: temp, PATH: `${bin}:/usr/bin:/bin`, DEVBOX_PROJECT_ROOT: project },
        timeoutMs: 5000,
      })
      return {
        result,
        installed: readFileSync(join(project, 'npm/bin/linear'), 'utf8'),
        versionDir: existsSync(join(project, 'linear-cli')),
        curlCalled: existsSync(join(root, 'curl-called')),
        xzCalled: existsSync(join(root, 'xz-called')),
        tempEntries: readdirSync(temp),
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }

  for (const arch of ['x86_64', 'aarch64'])
    test(`rejects a tampered ${arch} archive before extracting or installing and cleans temporary files`, async () => {
      const outcome = await runInstaller({ arch, archive: 'tampered archive bytes' })
      expect(outcome.result.kind).toBe('exited')
      if (outcome.result.kind === 'exited') expect(outcome.result.code).not.toBe(0)
      expect(outcome.result.stderr).toContain('Linear CLI archive digest mismatch')
      expect(outcome.curlCalled).toBe(true)
      expect(outcome.xzCalled).toBe(false)
      expect(outcome.installed).toBe('original-cli')
      expect(outcome.versionDir).toBe(false)
      expect(outcome.tempEntries).toEqual([])
    })

  test('refuses an unsupported architecture before downloading', async () => {
    const outcome = await runInstaller({ arch: 'riscv64', archive: '' })
    expect(outcome.result.kind).toBe('exited')
    if (outcome.result.kind === 'exited') expect(outcome.result.code).not.toBe(0)
    expect(outcome.result.stderr).toContain('Unsupported Linear CLI platform')
    expect(outcome.curlCalled).toBe(false)
    expect(outcome.installed).toBe('original-cli')
    expect(outcome.tempEntries).toEqual([])
  })
})
