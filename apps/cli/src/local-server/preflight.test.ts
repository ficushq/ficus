import { describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { runPreflight, type PreflightDeps, defaultPreflightDeps } from './preflight'
import { recordingRunner } from './runner'
import type { SetupOptions } from './types'

function opts(partial: Partial<SetupOptions>): SetupOptions {
  return {
    root: '/r',
    runtime: 'host',
    supervisor: 'pm2',
    port: 3000,
    apiUrl: 'http://localhost:3000',
    appUrl: 'http://localhost:3000',
    databaseMode: 'compose',
    databaseUrl: 'postgres://postgres:postgres@localhost:5432/tau',
    dbName: 'tau',
    instance: 'ficus',
    makeDefault: false,
    start: true,
    dryRun: false,
    yes: false,
    rebuildImage: false,
    explicit: new Set(),
    ...partial,
  }
}

function deps(
  overrides: Partial<PreflightDeps> & { responses?: Record<string, { code?: number; stdout?: string }> } = {}
) {
  const { responses, ...rest } = overrides
  const rec = recordingRunner(responses)
  const d: PreflightDeps = {
    runner: rec.runner,
    platform: 'darwin',
    which: (cmd) => (['bun', 'git', 'docker', 'tmux', 'k3d', 'kubectl'].includes(cmd) ? `/usr/bin/${cmd}` : null),
    nodeVersion: async () => '24.21.0',
    bunVersion: () => '1.3.8',
    pinnedBunVersion: () => '1.3.8',
    browserPaths: () => ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
    wsl: () => false,
    systemdActive: () => true,
    username: () => 'me',
    ...rest,
  }
  return { d, calls: rec.calls }
}

describe('runPreflight', () => {
  it('requires a functional launchd GUI domain', async () => {
    const { d } = deps({
      which: (cmd) => (cmd === 'launchctl' || ['git', 'docker', 'tmux'].includes(cmd) ? `/usr/bin/${cmd}` : null),
      responses: { 'launchctl print gui/': { code: 1 } },
    })
    const result = await runPreflight(opts({ supervisor: 'launchd' }), d)
    expect(result.failures.join('\n')).toMatch(/GUI login domain/i)
  })

  it('requires systemd-user on Linux with a functional user bus', async () => {
    const { d } = deps({
      platform: 'linux',
      which: (cmd) => (cmd === 'systemctl' || ['git', 'docker', 'tmux'].includes(cmd) ? `/usr/bin/${cmd}` : null),
      responses: { 'systemctl --user show-environment': { code: 1 } },
    })
    const result = await runPreflight(opts({ supervisor: 'systemd-user' }), d)
    expect(result.failures.join('\n')).toMatch(/user bus|XDG_RUNTIME_DIR/i)
    expect(result.warnings.join('\n')).toContain('sudo loginctl enable-linger me')
  })

  it('rejects native supervisors on the wrong platform', async () => {
    const { d } = deps({ platform: 'linux' })
    expect((await runPreflight(opts({ supervisor: 'launchd' }), d)).failures.join('\n')).toMatch(/only.*macOS/i)
  })

  it('passes a plain host setup on macOS', async () => {
    const { d } = deps()
    expect(await runPreflight(opts({}), d)).toEqual({ failures: [], warnings: [] })
  })
  it('fails when bun is older than the pin', async () => {
    const { d } = deps({ bunVersion: () => '1.2.0' })
    const r = await runPreflight(opts({}), d)
    expect(r.failures.join('\n')).toMatch(/bun 1\.2\.0.*1\.3\.8/)
  })
  it('fails on an unsupported platform with the WSL quickstart', async () => {
    const { d } = deps({ platform: 'win32' })
    const failures = (await runPreflight(opts({}), d)).failures.join('\n')
    expect(failures).toMatch(/macOS or Linux/)
    expect(failures).toMatch(/wsl --install -d Ubuntu-24\.04/)
    expect(failures).toMatch(/ficus\.sh\/cli\/setup\.sh/)
  })
  it('requires docker for the compose database and skips it for an external one', async () => {
    const { d } = deps({ which: (c) => (c === 'docker' ? null : `/usr/bin/${c}`) })
    expect((await runPreflight(opts({}), d)).failures.join('\n')).toMatch(/Docker/)
    expect((await runPreflight(opts({ databaseMode: 'external', databaseUrl: 'postgres://x/y' }), d)).failures).toEqual(
      []
    )
  })
  it('fails when docker is installed but the daemon is down', async () => {
    const { d } = deps({ responses: { 'docker info': { code: 1 } } })
    expect((await runPreflight(opts({}), d)).failures.join('\n')).toMatch(/docker info/)
  })
  it('requires linux + sysbox for docker-sysbox', async () => {
    const { d: mac } = deps({ responses: { 'docker info --format': { stdout: '{"sysbox-runc":{}}' } } })
    expect((await runPreflight(opts({ runtime: 'docker-sysbox' }), mac)).failures.join('\n')).toMatch(/Linux/)
    const { d: noSysbox } = deps({
      platform: 'linux',
      responses: { 'docker info --format': { stdout: '{"runc":{}}' } },
    })
    expect((await runPreflight(opts({ runtime: 'docker-sysbox' }), noSysbox)).failures.join('\n')).toMatch(/sysbox/)
    const { d: ok } = deps({
      platform: 'linux',
      responses: { 'docker info --format': { stdout: '{"sysbox-runc":{}}' } },
    })
    expect((await runPreflight(opts({ runtime: 'docker-sysbox' }), ok)).failures).toEqual([])
  })
  it('offers the guarded bootstrap when sysbox is missing on linux', async () => {
    const { d } = deps({
      platform: 'linux',
      responses: { 'docker info --format': { stdout: '{"runc":{}}' } },
    })
    const failures = (await runPreflight(opts({ runtime: 'docker-sysbox' }), d)).failures.join('\n')
    expect(failures).toMatch(/ficus server bootstrap-sysbox/)
    expect(failures).toMatch(/docs\/wiki\/sandbox-runtimes\.md#installing-sysbox/)
  })
  it('gives WSL hosts without systemd the /etc/wsl.conf recipe before the runtime probe', async () => {
    const { d } = deps({
      platform: 'linux',
      wsl: () => true,
      systemdActive: () => false,
      responses: { 'docker info --format': { stdout: '{"runc":{}}' } },
    })
    const failures = (await runPreflight(opts({ runtime: 'docker-sysbox' }), d)).failures.join('\n')
    expect(failures).toMatch(/\[boot\]/)
    expect(failures).toMatch(/wsl --shutdown/)
    // A WSL host WITH systemd does not get the recipe.
    const { d: booted } = deps({
      platform: 'linux',
      wsl: () => true,
      systemdActive: () => true,
      responses: { 'docker info --format': { stdout: '{"sysbox-runc":{}}' } },
    })
    expect((await runPreflight(opts({ runtime: 'docker-sysbox' }), booted)).failures).toEqual([])
  })
  it('requires k3d and kubectl for k3d', async () => {
    const { d } = deps({ which: (c) => (c === 'k3d' ? null : `/usr/bin/${c}`) })
    expect((await runPreflight(opts({ runtime: 'k3d' }), d)).failures.join('\n')).toMatch(/k3d/)
  })
  it('allows k3d only on the default instance', async () => {
    const { d } = deps()
    const labelled = await runPreflight(opts({ runtime: 'k3d', instance: 'smoke' }), d)
    expect(labelled.failures.join('\n')).toMatch(
      /k3d runtime shares ~\/\.ficus with the cluster.*only available on the default instance.*host\/docker-socket for "smoke"/s
    )
    // The default label is what k3d:setup's cluster and bind mount assume.
    expect((await runPreflight(opts({ runtime: 'k3d', instance: 'ficus' }), d)).failures).toEqual([])
  })
  it('warns (not fails) on host without tmux or a browser', async () => {
    const { d } = deps({ which: (c) => (c === 'tmux' ? null : `/usr/bin/${c}`), browserPaths: () => [] })
    const r = await runPreflight(opts({}), d)
    expect(r.failures).toEqual([])
    expect(r.warnings.join('\n')).toMatch(/tmux/)
    expect(r.warnings.join('\n')).toMatch(/browser/i)
  })
  it('treats FICUS_BROWSER_CHANNEL as configured (no browser warning when set)', async () => {
    const rec = recordingRunner({})
    const injectedEnv: NodeJS.ProcessEnv = {
      FICUS_BROWSER_CHANNEL: 'chrome',
      HOME: '/home/user',
    }
    const defaultDeps = defaultPreflightDeps('/r', rec.runner, injectedEnv)
    const d = {
      ...defaultDeps,
      nodeVersion: async () => '24.21.0',
      which: (cmd) => (['bun', 'git', 'docker', 'tmux', 'k3d', 'kubectl'].includes(cmd) ? `/usr/bin/${cmd}` : null),
    }
    const r = await runPreflight(opts({}), d)
    expect(r.failures).toEqual([])
    // When FICUS_BROWSER_CHANNEL is set, browserPaths() returns ['channel:chrome'], so no browser warning
    expect(r.warnings).toEqual([])
  })
  it('discovers Playwright-managed Chromium in cache directory', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'ficus-preflight-test-'))
    try {
      const home = tmpDir
      const cachePath = join(home, '.cache/ms-playwright/chromium-1234/chrome-linux64')
      const chromePath = join(cachePath, 'chrome')
      // Create the directory structure and a mock executable
      const fs = await import('fs/promises')
      await fs.mkdir(cachePath, { recursive: true })
      await fs.writeFile(chromePath, '#!/bin/bash\necho chrome', { mode: 0o755 })

      const rec = recordingRunner({})
      const injectedEnv: NodeJS.ProcessEnv = {
        HOME: home,
      }
      const defaultDeps = defaultPreflightDeps('/r', rec.runner, injectedEnv)
      const paths = defaultDeps.browserPaths()

      // Should find the Playwright Chromium
      expect(paths.some((p) => p.includes('chrome-linux64'))).toBe(true)
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })
  it('(a) both env vars set, path valid → the path is reported, not the channel', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'ficus-preflight-test-'))
    try {
      const chromePath = join(tmpDir, 'chrome')
      // Create a mock executable file
      const fs = await import('fs/promises')
      await fs.writeFile(chromePath, '#!/bin/bash\necho chrome', { mode: 0o755 })

      const rec = recordingRunner({})
      const injectedEnv: NodeJS.ProcessEnv = {
        FICUS_BROWSER_EXECUTABLE_PATH: chromePath,
        FICUS_BROWSER_CHANNEL: 'chrome',
        HOME: tmpDir,
      }
      const defaultDeps = defaultPreflightDeps('/r', rec.runner, injectedEnv)
      const paths = defaultDeps.browserPaths()

      // Path should be returned, not channel (channel should not be in the list)
      expect(paths).toEqual([chromePath])
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })
  it('(b) FICUS_BROWSER_EXECUTABLE_PATH pointing at a directory → not reported', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'ficus-preflight-test-'))
    try {
      const dirPath = join(tmpDir, 'fake-app')
      const fs = await import('fs/promises')
      await fs.mkdir(dirPath)

      const rec = recordingRunner({})
      const injectedEnv: NodeJS.ProcessEnv = {
        FICUS_BROWSER_EXECUTABLE_PATH: dirPath,
        HOME: tmpDir,
      }
      const defaultDeps = defaultPreflightDeps('/r', rec.runner, injectedEnv)
      const paths = defaultDeps.browserPaths()

      // Directory should not be in the reported paths (the directory path itself should not be returned)
      expect(paths.includes(dirPath)).toBe(false)
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })
  it('(c) FICUS_BROWSER_CHANNEL=typo → ignored (falls through to probe list)', async () => {
    const rec = recordingRunner({})
    const injectedEnv: NodeJS.ProcessEnv = {
      FICUS_BROWSER_CHANNEL: 'invalid-channel-name',
      HOME: '/nonexistent/home',
    }
    const defaultDeps = defaultPreflightDeps('/r', rec.runner, injectedEnv)
    const paths = defaultDeps.browserPaths()

    // Invalid channel should be ignored; should not return channel: format
    expect(paths.some((p) => p.startsWith('channel:'))).toBe(false)
  })
  it('(d) FICUS_BROWSER_CHANNEL=chrome still reported', async () => {
    const rec = recordingRunner({})
    const injectedEnv: NodeJS.ProcessEnv = {
      FICUS_BROWSER_CHANNEL: 'chrome',
      HOME: '/nonexistent/home',
    }
    const defaultDeps = defaultPreflightDeps('/r', rec.runner, injectedEnv)
    const paths = defaultDeps.browserPaths()

    // Valid channel should be returned
    expect(paths).toEqual(['channel:chrome'])
  })
})

it.each([null, '20.20.0', '22.12.0', 'unknown'])('rejects unsupported Node %s before setup builds', async (version) => {
  const { d } = deps({ nodeVersion: async () => version })
  expect((await runPreflight(opts({}), d)).failures.join('\n')).toContain('Node.js 22.19.0 or newer')
})

it.each(['22.19.0', '24.21.0'])('accepts supported Node %s', async (version) => {
  const { d } = deps({ nodeVersion: async () => version })
  expect((await runPreflight(opts({}), d)).failures).toEqual([])
})
