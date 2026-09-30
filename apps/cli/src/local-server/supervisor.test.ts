import { describe, expect, it } from 'bun:test'
import { recordingRunner } from './runner'
import { pm2Supervisor, type SupervisorContext } from './supervisor'

function context(): SupervisorContext {
  const rec = recordingRunner()
  return {
    supervisor: 'pm2',
    root: '/repo',
    label: 'smoke',
    home: '/home/me',
    bunPath: '/bin/bun',
    pathEnv: '/bin',
    platform: 'linux',
    arch: 'x64',
    uid: 1000,
    username: 'me',
    runner: rec.runner,
    which: () => null,
    log: () => {},
  }
}

describe('pm2Supervisor', () => {
  it('restarts worker first and API last in separate calls', async () => {
    const ctx = context()
    const calls: string[][] = []
    ctx.runner = async (command) => {
      calls.push(command)
      return { code: 0, stdout: '', stderr: '' }
    }
    await pm2Supervisor.restart(ctx)
    expect(calls).toEqual([
      ['bunx', 'pm2', 'restart', 'ficus-smoke-worker', '--update-env'],
      ['bunx', 'pm2', 'restart', 'ficus-smoke-api', '--update-env'],
    ])
  })

  it('normalizes status rows through the shared contract', async () => {
    const ctx = context()
    ctx.runner = async () => ({
      code: 0,
      stderr: '',
      stdout: JSON.stringify([{ name: 'ficus-smoke-api', pid: 9, pm2_env: { status: 'online', pm_cwd: '/repo' } }]),
    })
    expect(await pm2Supervisor.status(ctx)).toEqual([
      { name: 'ficus-smoke-api', status: 'online', pid: 9, cwd: '/repo' },
    ])
  })
})

import { launchdSupervisor } from './launchd'
import { systemdUserSupervisor } from './systemd-user'
import { supervisorAdapter } from './supervisor'

describe('supervisorAdapter', () => {
  it('selects exactly the recorded adapter', () => {
    expect(supervisorAdapter('pm2')).toBe(pm2Supervisor)
    expect(supervisorAdapter('launchd')).toBe(launchdSupervisor)
    expect(supervisorAdapter('systemd-user')).toBe(systemdUserSupervisor)
  })
})
