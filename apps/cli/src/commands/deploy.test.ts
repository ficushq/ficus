import { beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { Command } from 'commander'
import { apiDelete, apiGet, apiPatch, apiPost } from '../client'
import { outputError, setOutputOptions } from '../output'
import { registerDeployCommands } from './deploy'

describe('deploy CLI commands', () => {
  beforeEach(() => {
    ;(apiGet as ReturnType<typeof mock>).mockClear()
    ;(apiPost as ReturnType<typeof mock>).mockClear()
    ;(apiPatch as ReturnType<typeof mock>).mockClear()
    ;(apiDelete as ReturnType<typeof mock>).mockClear()
    ;(outputError as ReturnType<typeof mock>).mockClear()
    ;(apiGet as ReturnType<typeof mock>).mockResolvedValue({ id: 'deployment-1', status: 'planned', lines: [] })
    ;(apiPost as ReturnType<typeof mock>).mockResolvedValue({ id: 'deployment-1', status: 'ready', name: 'web' })
    ;(apiPatch as ReturnType<typeof mock>).mockResolvedValue({ id: 'deployment-1', status: 'failed' })
    ;(apiDelete as ReturnType<typeof mock>).mockResolvedValue({ id: 'local-1', status: 'stopped', name: 'web' })
  })

  async function run(args: string[]): Promise<void> {
    const program = new Command()
    program.exitOverride()
    program.option('--json')
    program.option('--quiet')
    program.hook('preAction', (command) => setOutputOptions(command.optsWithGlobals()))
    registerDeployCommands(program)
    await program.parseAsync(['--quiet', ...args], { from: 'user' })
  }

  it('maps external providers to GET /api/deploy/providers', async () => {
    await run(['deploy', 'external', 'providers'])
    expect(apiGet).toHaveBeenCalledWith('/api/deploy/providers')
  })

  it('maps external list to GET /api/squads/:id/deployments', async () => {
    ;(apiGet as ReturnType<typeof mock>).mockResolvedValue([])
    await run(['deploy', 'external', 'list', 'squad-1', '--include-archived'])
    expect(apiGet).toHaveBeenCalledWith('/api/squads/squad-1/deployments?includeArchived=true')
  })

  it('maps external record to POST /api/squads/:id/deployments', async () => {
    await run([
      'deploy',
      'external',
      'record',
      'squad-1',
      '--name',
      'docs site',
      '--provider',
      'github-pages',
      '--url',
      'https://example.github.io/app',
      '--provider-project-url',
      'https://github.com/example/app/actions',
      '--environment',
      'production',
      '--status',
      'ready',
      '--app',
      '/workspace/app',
      '--metadata',
      '{"branch":"main"}',
    ])
    expect(apiPost).toHaveBeenCalledWith(
      '/api/squads/squad-1/deployments',
      expect.objectContaining({
        name: 'docs site',
        provider: 'github-pages',
        providerProjectUrl: 'https://github.com/example/app/actions',
        metadata: { branch: 'main', appPath: '/workspace/app' },
      })
    )
  })

  it('maps external archive to DELETE /api/deployments/:id', async () => {
    await run(['deploy', 'external', 'archive', 'deployment-1'])
    expect(apiDelete).toHaveBeenCalledWith('/api/deployments/deployment-1')
  })

  it('maps external update to PATCH /api/deployments/:id', async () => {
    await run([
      'deploy',
      'external',
      'update',
      'deployment-1',
      '--name',
      'web prod',
      '--status',
      'failed',
      '--provider-project-url',
      'https://railway.com/project/abc',
    ])
    expect(apiPatch).toHaveBeenCalledWith('/api/deployments/deployment-1', {
      name: 'web prod',
      status: 'failed',
      providerProjectUrl: 'https://railway.com/project/abc',
    })
  })

  it('maps local start to POST /api/squads/:id/local-deployments', async () => {
    await run(['deploy', 'local', 'start', 'squad-1', '--name', 'web', '--port', '5173', '--command', 'bun run dev'])
    expect(apiPost).toHaveBeenCalledWith(
      '/api/squads/squad-1/local-deployments',
      expect.objectContaining({
        name: 'web',
        port: 5173,
        mode: 'managed',
      })
    )
  })

  it('maps local attach --log-path to the create body', async () => {
    await run([
      'deploy',
      'local',
      'attach',
      'squad-1',
      '--name',
      'web',
      '--port',
      '5173',
      '--log-path',
      'my-app/app.log',
    ])
    expect(apiPost).toHaveBeenCalledWith('/api/squads/squad-1/local-deployments', {
      name: 'web',
      port: 5173,
      mode: 'attached',
      command: undefined,
      cwd: undefined,
      envSecretRefs: undefined,
      restartPolicy: undefined,
      logPath: 'my-app/app.log',
    })
  })

  it('maps local start --alias to the create body', async () => {
    await run([
      'deploy',
      'local',
      'start',
      'squad-1',
      '--name',
      'web',
      '--command',
      'bun run dev',
      '--alias',
      'dashboard',
    ])
    expect(apiPost).toHaveBeenCalledWith(
      '/api/squads/squad-1/local-deployments',
      expect.objectContaining({ name: 'web', alias: 'dashboard' })
    )
  })

  it('maps local alias to PATCH /api/local-deployments/:id, and --clear to a null alias', async () => {
    ;(apiPatch as ReturnType<typeof mock>).mockResolvedValue({
      id: 'local-1',
      name: 'web',
      status: 'running',
      alias: 'dashboard',
      urlPathOrHost: 'https://noah--dashboard.ficus.garden/?_ficus_token=t',
    })
    const log = spyOn(console, 'log').mockImplementation(() => {})
    try {
      await run(['deploy', 'local', 'alias', 'local-1', 'dashboard'])
      expect(apiPatch).toHaveBeenCalledWith('/api/local-deployments/local-1', { alias: 'dashboard' })
      expect(log).toHaveBeenCalledWith('Local app web is now dashboard')
      expect(log).toHaveBeenCalledWith('  URL: https://noah--dashboard.ficus.garden/?_ficus_token=t')

      await run(['deploy', 'local', 'alias', 'local-1', '--clear'])
      expect(apiPatch).toHaveBeenCalledWith('/api/local-deployments/local-1', { alias: null })
    } finally {
      log.mockRestore()
    }
  })

  it('local alias needs exactly one of a name or --clear', async () => {
    await run(['deploy', 'local', 'alias', 'local-1'])
    await run(['deploy', 'local', 'alias', 'local-1', 'dashboard', '--clear'])
    expect(apiPatch).not.toHaveBeenCalled()
    expect(outputError).toHaveBeenCalledTimes(2)
  })

  it('maps local lifecycle commands to local-deployments endpoints', async () => {
    await run(['deploy', 'local', 'list', 'squad-1'])
    await run(['deploy', 'local', 'get', 'local-1'])
    await run(['deploy', 'local', 'restart', 'local-1'])
    await run(['deploy', 'local', 'stop', 'local-1'])
    await run(['deploy', 'local', 'archive', 'local-1'])
    await run(['deploy', 'local', 'logs', 'local-1', '--tail', '50'])

    expect(apiGet).toHaveBeenCalledWith('/api/squads/squad-1/local-deployments')
    expect(apiGet).toHaveBeenCalledWith('/api/local-deployments/local-1')
    expect(apiPost).toHaveBeenCalledWith('/api/local-deployments/local-1/restart')
    expect(apiPost).toHaveBeenCalledWith('/api/local-deployments/local-1/stop')
    expect(apiDelete).toHaveBeenCalledWith('/api/local-deployments/local-1')
    expect(apiGet).toHaveBeenCalledWith('/api/local-deployments/local-1/logs?tail=50')
  })

  it('local restart reports the new run it launched', async () => {
    ;(apiPost as ReturnType<typeof mock>).mockResolvedValue({ id: 'local-1', name: 'web', status: 'restarting' })
    const log = spyOn(console, 'log').mockImplementation(() => {})
    try {
      await run(['deploy', 'local', 'restart', 'local-1'])
      expect(log).toHaveBeenCalledWith('Restarted local app web: restarting')
      expect(outputError).not.toHaveBeenCalled()
    } finally {
      log.mockRestore()
    }
  })

  it('local restart fails instead of printing a stale status when no new run started', async () => {
    ;(apiPost as ReturnType<typeof mock>).mockResolvedValue({ id: 'local-1', name: 'web', status: 'stopped' })
    await run(['deploy', 'local', 'restart', 'local-1'])
    expect(outputError).toHaveBeenCalledWith(new Error('Local app web did not restart: it is stopped'))
  })

  it('local restart surfaces the server reason when the app cannot be relaunched', async () => {
    const reason = new Error('Managed app launch failed; check startup logs.')
    ;(apiPost as ReturnType<typeof mock>).mockRejectedValue(reason)
    await run(['deploy', 'local', 'restart', 'local-1'])
    expect(outputError).toHaveBeenCalledWith(reason)
  })
})
