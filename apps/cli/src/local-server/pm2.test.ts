import { describe, expect, it } from 'bun:test'
import { instanceNames } from './instance'
import { parseJlist, pm2Args, runPm2 } from './pm2'
import { recordingRunner } from './runner'

const ficus = instanceNames('ficus')
const smoke = instanceNames('smoke')

describe('pm2Args', () => {
  it('builds the ecosystem-scoped start and the named stop/restart', () => {
    expect(pm2Args('start', ficus)).toEqual([
      'start',
      'ecosystem.config.js',
      '--only',
      'ficus-api,ficus-worker',
      '--update-env',
    ])
    expect(pm2Args('stop', ficus)).toEqual(['stop', 'ficus-api', 'ficus-worker'])
    expect(pm2Args('restart', ficus)).toEqual(['restart', 'ficus-api', 'ficus-worker', '--update-env'])
    expect(pm2Args('delete', ficus)).toEqual(['delete', 'ficus-api', 'ficus-worker'])
    expect(pm2Args('logs', ficus, ['ficus-api', '--lines', '50', '--nostream'])).toEqual([
      'logs',
      'ficus-api',
      '--lines',
      '50',
      '--nostream',
    ])
  })
  it('addresses the instance apps for a labelled instance', () => {
    expect(pm2Args('start', smoke)).toEqual([
      'start',
      'ecosystem.config.js',
      '--only',
      'ficus-smoke-api,ficus-smoke-worker',
      '--update-env',
    ])
    expect(pm2Args('stop', smoke)).toEqual(['stop', 'ficus-smoke-api', 'ficus-smoke-worker'])
    expect(pm2Args('restart', smoke)).toEqual(['restart', 'ficus-smoke-api', 'ficus-smoke-worker', '--update-env'])
    expect(pm2Args('delete', smoke)).toEqual(['delete', 'ficus-smoke-api', 'ficus-smoke-worker'])
  })
})

describe('parseJlist', () => {
  it('extracts name, status, pid and cwd, ignoring unrelated apps', () => {
    const json = JSON.stringify([
      { name: 'ficus-api', pid: 11, pm2_env: { status: 'online', pm_cwd: '/r' } },
      { name: 'other', pid: 12, pm2_env: { status: 'online', pm_cwd: '/o' } },
      { name: 'ficus-worker', pid: 0, pm2_env: { status: 'stopped', pm_cwd: '/r' } },
    ])
    expect(parseJlist(json, ficus)).toEqual([
      { name: 'ficus-api', status: 'online', pid: 11, cwd: '/r' },
      { name: 'ficus-worker', status: 'stopped', pid: 0, cwd: '/r' },
    ])
  })
  it('skips the [PM2] banner lines pm2 prints before the JSON on its first daemon start', () => {
    const banner = '[PM2] Spawning PM2 daemon with pm2_home=/root/.pm2\n[PM2] PM2 Successfully daemonized\n'
    const json = JSON.stringify([{ name: 'ficus-api', pid: 11, pm2_env: { status: 'online', pm_cwd: '/r' } }])
    expect(parseJlist(banner + json, ficus)).toEqual([{ name: 'ficus-api', status: 'online', pid: 11, cwd: '/r' }])
  })
  it('finds the array when a bracket also appears inside a banner message and inside JSON strings', () => {
    const noisy =
      '[PM2] Spawning PM2 daemon [pid 123] with pm2_home=/root/.pm2\n' +
      JSON.stringify([{ name: 'ficus-api', pid: 1, pm2_env: { status: 'online', pm_cwd: '/r [x]' } }])
    expect(parseJlist(noisy, ficus).map((p) => p.name)).toEqual(['ficus-api'])
  })
  it('returns [] for garbage', () => {
    expect(parseJlist('not json', ficus)).toEqual([])
  })
  it('keeps another instance apps out of the default instance view, and vice versa', () => {
    const json = JSON.stringify([
      { name: 'ficus-api', pid: 11, pm2_env: { status: 'online', pm_cwd: '/r' } },
      { name: 'ficus-smoke-api', pid: 21, pm2_env: { status: 'online', pm_cwd: '/s' } },
      { name: 'ficus-smoke-worker', pid: 22, pm2_env: { status: 'online', pm_cwd: '/s' } },
    ])
    expect(parseJlist(json, ficus)).toEqual([{ name: 'ficus-api', status: 'online', pid: 11, cwd: '/r' }])
    expect(parseJlist(json, smoke)).toEqual([
      { name: 'ficus-smoke-api', status: 'online', pid: 21, cwd: '/s' },
      { name: 'ficus-smoke-worker', status: 'online', pid: 22, cwd: '/s' },
    ])
  })
})

describe('runPm2', () => {
  it('invokes bunx pm2 from the root', async () => {
    const rec = recordingRunner()
    await runPm2(rec.runner, '/root', pm2Args('save', ficus))
    expect(rec.calls[0].command).toEqual(['bunx', 'pm2', 'save'])
    expect(rec.calls[0].options.cwd).toBe('/root')
  })
})
