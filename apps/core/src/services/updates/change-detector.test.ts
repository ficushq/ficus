import { describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { LEGACY_UNITS } from '@ficus/shared/node'

import type { DeploymentFlavor } from './deployment-flavor'
import {
  commandsForTasks,
  detectUpdateTasks,
  isApiRestartCommand,
  isServiceRestartCommand,
  restartCommandsFor,
} from './change-detector'

// Empty dirs so hostSystemdUnits()/launchdLabel() take the legacy branch —
// deterministic regardless of what is actually installed on the test host.
const emptyHostDirs = () => {
  const unitDir = mkdtempSync(join(tmpdir(), 'change-detector-test-units-'))
  const launchAgentsDir = mkdtempSync(join(tmpdir(), 'change-detector-test-agents-'))
  return { unitDir, launchAgentsDir }
}

const K3D_PM2: DeploymentFlavor = { source: 'git-checkout', supervisor: 'pm2', sandboxRuntime: 'k3d-local' }
const SYSTEMD_DOCKER: DeploymentFlavor = {
  source: 'git-checkout',
  supervisor: 'systemd',
  sandboxRuntime: 'docker-socket',
}

describe('detectUpdateTasks', () => {
  it('maps web-only changes to web build only', () => {
    expect(detectUpdateTasks(['apps/web/src/App.tsx'], K3D_PM2)).toEqual(['web'])
  })

  it('rebuilds the web UI (with the farm) for farm and brand changes', () => {
    expect(detectUpdateTasks(['apps/farm/src/farm/FarmScreen.tsx'], K3D_PM2)).toEqual(['web'])
    expect(detectUpdateTasks(['brand/ficus-mark.svg'], K3D_PM2)).toEqual(['web'])
  })

  it('runs install before dependent builds for lockfile changes', () => {
    expect(detectUpdateTasks(['bun.lock'], K3D_PM2)).toEqual(['install', 'cli', 'sandbox', 'core', 'web'])
  })

  it('does not import sandbox for cli-only changes', () => {
    expect(detectUpdateTasks(['apps/cli/src/index.ts'], K3D_PM2)).toEqual(['cli', 'core'])
  })

  it('moves reload:worker and reload:api to the end of the update plan in order', () => {
    expect(commandsForTasks(['core', 'web'], [], K3D_PM2).map((c) => c.command)).toEqual([
      ['bun', 'run', 'build:core'],
      ['bun', 'run', 'build:web'],
      ['bun', 'run', 'reload:worker'],
      ['bun', 'run', 'reload:api'],
    ])
  })

  it('imports sandbox for sandbox runtime changes', () => {
    expect(detectUpdateTasks(['packages/k8s-sandbox/src/server.ts'], K3D_PM2)).toContain('sandbox')
  })

  it('maps shared client package changes to web without sandbox import', () => {
    expect(detectUpdateTasks(['packages/client-core/src/queryKeys.ts'], K3D_PM2)).toEqual(['web'])
    expect(detectUpdateTasks(['packages/client-react/src/useAgentConversation.ts'], K3D_PM2)).toEqual(['web'])
  })

  it('imports sandbox for shared package changes', () => {
    expect(detectUpdateTasks(['packages/shared/src/index.ts'], K3D_PM2)).toEqual(['cli', 'sandbox', 'core', 'web'])
  })
})

describe('flavor-aware planning', () => {
  it('uses validated labeled targets for native user supervisors', () => {
    const { unitDir, launchAgentsDir } = emptyHostDirs()
    try {
      expect(restartCommandsFor('systemd-user', { instance: 'Smoke' })).toEqual([
        ['systemctl', '--user', 'restart', 'tau-smoke-worker.service'],
        ['systemctl', '--user', '--no-block', 'restart', 'tau-smoke-api.service'],
      ])
      // No legacy plist installed for this processName, so the new label wins.
      expect(restartCommandsFor('launchd', { instance: 'smoke', uid: 501, launchAgentsDir })).toEqual([
        ['launchctl', 'kickstart', '-k', 'gui/501/sh.ficus.tau-smoke-worker'],
        ['launchctl', 'kickstart', '-k', 'gui/501/sh.ficus.tau-smoke-api'],
      ])
      expect(() => restartCommandsFor('launchd', { instance: '../api', uid: 501 })).toThrow(/instance/i)
      for (const command of restartCommandsFor('launchd', { instance: 'smoke', uid: 501, launchAgentsDir }))
        expect(isServiceRestartCommand(command)).toBe(true)
      expect(isApiRestartCommand(['systemctl', '--user', '--no-block', 'restart', 'tau-smoke-api.service'])).toBe(true)
    } finally {
      rmSync(unitDir, { recursive: true, force: true })
      rmSync(launchAgentsDir, { recursive: true, force: true })
    }
  })

  it('keeps pm2 reload commands for the pm2 flavor', () => {
    const commands = commandsForTasks(['core'], [], K3D_PM2)
    const restarts = commands.filter((c) => c.command.join(' ').includes('reload:'))
    expect(restarts.map((c) => c.command.join(' '))).toEqual(['bun run reload:worker', 'bun run reload:api'])
  })

  it('uses systemctl restarts (worker first, api last) for the systemd flavor', () => {
    const commands = commandsForTasks(['core'], [], SYSTEMD_DOCKER)
    const restarts = commands.filter((c) => c.command.includes('systemctl') || c.command.includes('sudo'))
    expect(restarts).toHaveLength(2)
    expect(restarts[0].command.join(' ')).toContain(`systemctl restart ${LEGACY_UNITS.worker}`)
    expect(restarts[1].command.join(' ')).toContain(`systemctl restart ${LEGACY_UNITS.api}`)
  })

  it('systemd restart commands are sudo-prefixed only when not root, using the legacy units by default', () => {
    const unitDir = mkdtempSync(join(tmpdir(), 'change-detector-test-units-'))
    try {
      expect(restartCommandsFor('systemd', { isRoot: true, unitDir })[0]).toEqual([
        'systemctl',
        'restart',
        LEGACY_UNITS.worker,
      ])
      expect(restartCommandsFor('systemd', { isRoot: false, unitDir })[0]).toEqual([
        'sudo',
        '-n',
        'systemctl',
        'restart',
        LEGACY_UNITS.worker,
      ])
    } finally {
      rmSync(unitDir, { recursive: true, force: true })
    }
  })

  it('systemd restart commands use the ficus units once the ficus-api unit file exists', () => {
    const unitDir = mkdtempSync(join(tmpdir(), 'change-detector-test-units-'))
    try {
      writeFileSync(join(unitDir, 'ficus-api.service'), '')
      expect(restartCommandsFor('systemd', { isRoot: true, unitDir })).toEqual([
        ['systemctl', 'restart', 'ficus-worker'],
        ['systemctl', 'restart', 'ficus-api'],
      ])
    } finally {
      rmSync(unitDir, { recursive: true, force: true })
    }
  })

  it('excludes the sandbox task for non-k3d runtimes', () => {
    const files = ['packages/k8s-sandbox/src/x.ts']
    expect(detectUpdateTasks(files, K3D_PM2)).toContain('sandbox')
    expect(detectUpdateTasks(files, SYSTEMD_DOCKER)).not.toContain('sandbox')
  })
})
