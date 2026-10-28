import { expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { integrationWrapperPreamble } from './integration-wrapper-path'

test('post-activation preamble loads token-free Git bindings only for an agent identity, independently of cwd/env file', async () => {
  const root = mkdtempSync(join(tmpdir(), 'integration-git-bindings-')),
    bin = join(root, '.ficus', 'integration-bin')
  mkdirSync(bin, { recursive: true })
  writeFileSync(join(bin, '.git-config'), 'git() { printf "per-command-git\\n"; }\n')
  try {
    for (const agent of [false, true]) {
      const command = integrationWrapperPreamble(bin) + (agent ? 'git --version' : 'type git')
      const child = Bun.spawn(['/bin/sh', '-c', command], {
        env: { PATH: '/usr/bin:/bin', ...(agent ? { FICUS_TOKEN: 'synthetic-agent' } : {}) },
        cwd: tmpdir(),
        timeout: 3000,
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const output = await new Response(child.stdout).text()
      expect(await child.exited).toBe(0)
      if (agent) expect(output).toBe('per-command-git\n')
      else expect(output).not.toContain('per-command-git')
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
