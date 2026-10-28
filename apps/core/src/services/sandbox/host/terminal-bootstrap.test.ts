import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { renderHostTerminalBootstrap, ensureHostTerminalBootstrap } from './terminal-bootstrap'
import { runCapturedProcess } from '../../../test-utils/captured-process'

test('managed Bash terminal runs login initialization first, restores wrapper PATH, and grants no agent identity', async () => {
  const root = mkdtempSync(join(tmpdir(), 'host-terminal-bootstrap-'))
  try {
    const system = join(root, 'system-profile'),
      first = join(root, '.bash_profile'),
      ignored = join(root, '.profile'),
      rc = join(root, 'managed-bashrc')
    writeFileSync(system, 'export INITIALIZED=system\n')
    writeFileSync(
      first,
      'export INITIALIZED="$INITIALIZED:user"\nexport PATH=/usr/bin:/bin\nexport FICUS_TOKEN=synthetic-stale-identity\n'
    )
    writeFileSync(ignored, 'export INITIALIZED=wrong-profile\n')
    writeFileSync(
      rc,
      renderHostTerminalBootstrap({
        systemProfile: system,
        userProfiles: [first, ignored],
        pathPrefix: ['/managed/ficus-bin', '/managed/integration-bin'],
      })
    )
    const result = await runCapturedProcess(
      [
        '/bin/bash',
        '--noprofile',
        '--rcfile',
        rc,
        '-i',
        '-c',
        'printf "%s\\n" "$INITIALIZED" "$PATH" "${FICUS_TOKEN:-no-identity}"',
      ],
      {
        env: { HOME: root, PATH: '/bin', TERM: 'dumb' },
        timeoutMs: 3000,
      }
    )
    expect(result).toMatchObject({
      kind: 'exited',
      code: 0,
      stdout: 'system:user\n/managed/ficus-bin:/managed/integration-bin:/usr/bin:/bin\nno-identity\n',
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('managed terminal bootstrap is token-free and stored outside workspace overrides', () => {
  const root = mkdtempSync(join(tmpdir(), 'host-terminal-config-')),
    old = process.env.HOME_DIR
  process.env.HOME_DIR = root
  try {
    const file = ensureHostTerminalBootstrap('11111111-2222-4333-8444-555555555555', '/synthetic/operator-home')
    expect(file.startsWith(join(root, 'host', 'terminals'))).toBe(true)
    const content = readFileSync(file, 'utf8')
    expect(content).toContain('/synthetic/operator-home/.bash_profile')
    expect(content).toContain('/workspaces/squads/11111111-2222-4333-8444-555555555555/.ficus/integration-bin')
    expect(content).not.toContain('synthetic-stale-identity')
  } finally {
    if (old === undefined) delete process.env.HOME_DIR
    else process.env.HOME_DIR = old
    rmSync(root, { recursive: true, force: true })
  }
})
