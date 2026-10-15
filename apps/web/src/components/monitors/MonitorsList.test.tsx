import { describe, expect, it } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Monitor } from '@ficus/shared'
import { MonitorsList } from './MonitorsList'

const monitor: Monitor = {
  id: 'monitor-1',
  agentId: 'agent-1',
  sandboxId: 'sandbox-1',
  label: 'build watch',
  description: 'checks builds',
  command: 'bun test --watch',
  cwd: null,
  status: 'running',
  processId: 'proc-1',
  timeoutMs: 30000,
  maxBatchLines: 20,
  maxBatchBytes: 4096,
  batchDebounceMs: 750,
  exitCode: null,
  lastBatchAt: null,
  linesEmitted: 4,
  bytesEmitted: 120,
  createdAt: '2026-06-10T00:00:00.000Z',
  startedAt: '2026-06-10T00:00:01.000Z',
  endedAt: null,
  failureReason: null,
  failureKind: null,
  restartPolicy: 'never',
  restartLimit: 5,
  restartCount: 0,
  rapidRestartCount: 0,
  launchedAt: '2026-06-10T00:00:01.000Z',
  deadlineAt: '2026-06-10T00:00:31.000Z',
  nextRestartAt: null,
  lastRestartAt: null,
  lastRestartReason: null,
}

describe('MonitorsList', () => {
  it('renders monitor management rows with cancel affordance for active monitors', () => {
    const html = renderToStaticMarkup(
      <MonitorsList rows={[monitor]} onSelect={() => {}} onCancel={() => {}} showAgentColumn canCancel />
    )

    expect(html).toContain('build watch')
    expect(html).toContain('running')
    expect(html).toContain('agent-1')
    expect(html).toContain('Cancel')
  })

  it('disables monitor cancellation when permission is denied', () => {
    const html = renderToStaticMarkup(
      <MonitorsList rows={[monitor]} onSelect={() => {}} onCancel={() => {}} showAgentColumn canCancel={false} />
    )

    expect(html).toContain('Cancel')
    expect(html).toContain('disabled=""')
    expect(html).toContain('You do not have permission to cancel monitors')
  })

  it('shows the restart policy, restart count and a pending relaunch', () => {
    const never = renderToStaticMarkup(<MonitorsList rows={[monitor]} onSelect={() => {}} onCancel={() => {}} />)
    expect(never).toContain('Restart')
    expect(never).toContain('>never<')

    const restarting: Monitor = {
      ...monitor,
      restartPolicy: 'on-loss',
      restartCount: 2,
      rapidRestartCount: 1,
      nextRestartAt: '2026-06-10T00:05:00.000Z',
      lastRestartReason: 'sandbox restarted',
    }
    const html = renderToStaticMarkup(<MonitorsList rows={[restarting]} onSelect={() => {}} onCancel={() => {}} />)
    expect(html).toContain('on-loss · 2 restarts · relaunch pending')
    expect(html).toContain('title="sandbox restarted"')
  })

  it('renders an empty state', () => {
    const html = renderToStaticMarkup(<MonitorsList rows={[]} onSelect={() => {}} onCancel={() => {}} />)

    expect(html).toContain('No monitors found')
  })
})
