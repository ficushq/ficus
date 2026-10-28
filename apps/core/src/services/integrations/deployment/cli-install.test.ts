import { expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { deploymentCliSetup, type DeploymentBinary } from './cli-install'
import { runCapturedProcess } from '../../../test-utils/captured-process'

for (const binary of ['wrangler', 'vercel', 'netlify', 'doctl', 'railway', 'supabase'] as DeploymentBinary[]) {
  test(`${binary} installer rejects a corrupted public archive before installation and cleans temporary files`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'deploy-cli-integrity-'))
    try {
      const bin = join(root, 'bin'),
        temp = join(root, 'tmp'),
        project = join(root, 'project')
      for (const path of [bin, temp, join(project, 'npm/bin')]) mkdirSync(path, { recursive: true })
      writeFileSync(join(project, 'npm/bin', binary), 'original-cli')
      writeFileSync(join(bin, 'node'), `#!/bin/sh\nexec '${process.execPath}' "$@"\n`, { mode: 0o755 })
      writeFileSync(
        join(bin, 'npm'),
        '#!/bin/sh\n[ "$1" = pack ] || exit 99\nprintf corrupted > fixture.tgz\nprintf "fixture.tgz\\n"\n',
        { mode: 0o755 }
      )
      writeFileSync(join(bin, 'curl'), '#!/bin/sh\nprintf corrupted > cli.tar.gz\n', { mode: 0o755 })
      const result = await runCapturedProcess(['/bin/sh', '-c', deploymentCliSetup(binary).script], {
        env: { HOME: root, TMPDIR: temp, PATH: `${bin}:/usr/bin:/bin`, DEVBOX_PROJECT_ROOT: project },
        timeoutMs: 3000,
      })
      expect(result.kind).toBe('exited')
      if (result.kind === 'exited') expect(result.code).not.toBe(0)
      expect(readFileSync(join(project, 'npm/bin', binary), 'utf8')).toBe('original-cli')
      expect(readdirSync(temp)).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
}
