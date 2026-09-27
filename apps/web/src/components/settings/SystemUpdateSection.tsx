import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import clsx from 'clsx'
import {
  applyTargetedUpdate,
  applyUpdate,
  checkForUpdates,
  DEFAULT_LOCAL_AUTO_UPDATE_SETTINGS,
  MANUAL_UPDATE_TARGETS,
  patchUpdateSettings,
} from '../../api/updates'
import type { ManualUpdateTarget } from '../../api/updates'
import { queries } from '../../queryOptions'
import { queryKeys } from '../../queryKeys'
import { AnsiText } from '../AnsiText'
import { getUpdateLoaderMessage } from './SystemUpdateSection.loader'
import { usePermissions } from '../../hooks/usePermissions'
import { FormSkeleton } from '../loading/Skeleton'
import { desktopInstance, desktopUpdates } from '../../lib/desktop'
import { DesktopUpdatePanel } from './DesktopUpdatePanel'

export function SystemUpdateSection() {
  // Inside Tau Desktop the bundled local instance owns updates natively; the git
  // updater endpoints refuse all actions there. An attached or remote instance
  // still updates like any other server, so it keeps the git updater section.
  const updates = desktopUpdates()
  const kind = desktopInstance()?.kind
  const { can, isLoading: permissionsLoading } = usePermissions()
  if (updates && (kind === undefined || kind === 'local'))
    return <DesktopUpdatePanel updates={updates} canWrite={!permissionsLoading && can('updates:write')} />
  return <GitUpdateSection />
}

function GitUpdateSection() {
  const qc = useQueryClient()
  const [selectedTargets, setSelectedTargets] = useState<Set<ManualUpdateTarget>>(new Set())
  const { can, isLoading: permissionsLoading } = usePermissions()
  const canWriteUpdates = !permissionsLoading && can('updates:write')
  const { data, isLoading, error } = useQuery(queries.updates.settings())
  const invalidate = () => qc.invalidateQueries({ queryKey: queryKeys.updates.all })
  const patch = useMutation({ mutationFn: patchUpdateSettings, onSettled: invalidate })
  const check = useMutation({ mutationFn: checkForUpdates, onSettled: invalidate })
  const apply = useMutation({
    mutationFn: applyUpdate,
    onSettled: invalidate,
  })
  const rebuild = useMutation({
    mutationFn: applyTargetedUpdate,
    onSettled: invalidate,
  })
  const statusQuery = useQuery({
    ...queries.updates.status(),
    // A desktop-managed instance never runs the git updater; stop polling once the server says so.
    refetchInterval: (query) => (query.state.data?.flavor?.supervisor === 'desktop' ? false : 1000),
  })
  const settings = data?.settings ?? DEFAULT_LOCAL_AUTO_UPDATE_SETTINGS
  const status = statusQuery.data ?? data?.status
  const latest = status?.latest
  const isApplying = apply.isPending || rebuild.isPending || status?.active || latest?.status === 'running'
  const loaderMessage = getUpdateLoaderMessage({
    isChecking: check.isPending,
    isRebuilding: rebuild.isPending,
    isUpdating: isApplying,
  })
  const toggleTarget = (target: ManualUpdateTarget) =>
    setSelectedTargets((prev) => {
      const next = new Set(prev)
      if (next.has(target)) next.delete(target)
      else next.add(target)
      return next
    })

  if (isLoading) return <FormSkeleton label="Loading update settings" sections={4} />
  if (error) return <div className="text-danger">Failed to load update settings: {(error as Error).message}</div>
  if (status?.flavor?.supervisor === 'desktop') return <DesktopManagedNotice />
  return (
    <section className="space-y-6 text-primary">
      <div>
        <h2 className="text-xl font-semibold text-primary">System Updates</h2>
        <p className="text-sm text-muted mt-1">
          Self-updater for git-based installs (pm2 local and systemd server installs). Uses git fast-forward pulls and
          hardcoded build commands. Automatic updates are disabled by default; enable them only for installs you want
          Tau to update on its own.
        </p>
      </div>
      {latest?.supported === false && (
        <div className="p-3 rounded bg-warning/10 text-warning">{latest.supportReason}</div>
      )}
      {status?.flavor && (
        <p className="text-sm text-muted">
          Detected: {status.flavor.supervisor} · runtime {status.flavor.sandboxRuntime}
        </p>
      )}
      {latest?.dirty && (
        <div className="p-3 rounded bg-warning/10 text-warning">
          Worktree has uncommitted changes. Commit or stash before updating.
        </div>
      )}
      <label className="flex items-center gap-3">
        <input
          type="checkbox"
          checked={settings.enabled}
          disabled={!canWriteUpdates}
          onChange={(e) => canWriteUpdates && patch.mutate({ enabled: e.target.checked })}
        />{' '}
        <span data-setting-target="auto-update-local-k3d-install" className="text-primary">
          Auto-update this instance
        </span>
      </label>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <label data-setting-target="remote" className="text-sm">
          Remote
          <input
            className="ficus-field mt-1 w-full rounded border border-th-border bg-surface px-2 py-1 text-primary"
            value={settings.remote}
            disabled={!canWriteUpdates}
            onChange={(e) => canWriteUpdates && patch.mutate({ remote: e.target.value })}
          />
        </label>
        <label data-setting-target="branch" className="text-sm">
          Branch
          <input
            className="ficus-field mt-1 w-full rounded border border-th-border bg-surface px-2 py-1 text-primary"
            value={settings.branch}
            disabled={!canWriteUpdates}
            onChange={(e) => canWriteUpdates && patch.mutate({ branch: e.target.value })}
          />
        </label>
        <label data-setting-target="interval-minutes" className="text-sm">
          Interval minutes
          <input
            type="number"
            min={1}
            className="ficus-field mt-1 w-full rounded border border-th-border bg-surface px-2 py-1 text-primary"
            value={settings.intervalMinutes}
            disabled={!canWriteUpdates}
            onChange={(e) => canWriteUpdates && patch.mutate({ intervalMinutes: Number(e.target.value) })}
          />
        </label>
      </div>
      {loaderMessage && (
        <div className="flex items-center gap-3 p-3 bg-status-progress-50 dark:bg-status-progress-900/20 border border-status-progress-200 dark:border-status-progress-800 rounded-md">
          <div className="animate-spin h-4 w-4 border-2 border-status-progress-500 border-t-transparent rounded-full shrink-0" />
          <p className="text-sm text-status-progress-800 dark:text-status-progress-200">{loaderMessage}</p>
        </div>
      )}
      <div className="flex gap-2">
        <button
          className={clsx(
            'ficus-button',
            'px-4 py-2.5 md:py-2 rounded-md text-sm font-medium min-h-[44px] md:min-h-0 shrink-0',
            'bg-surface border border-th-border text-primary hover:bg-surface-hover',
            'disabled:opacity-50 disabled:cursor-not-allowed'
          )}
          onClick={() => check.mutate()}
          disabled={!canWriteUpdates || check.isPending || isApplying}
        >
          {check.isPending ? 'Checking…' : 'Check now'}
        </button>
        <button
          className={clsx(
            'ficus-button',
            'px-4 py-2.5 md:py-2 rounded-md text-sm font-medium min-h-[44px] md:min-h-0 shrink-0',
            'bg-accent text-on-accent hover:bg-accent-hover active:bg-accent-active',
            'disabled:opacity-50 disabled:cursor-not-allowed'
          )}
          onClick={() => apply.mutate()}
          disabled={!canWriteUpdates || isApplying || check.isPending}
        >
          {isApplying ? 'Updating…' : 'Update now'}
        </button>
      </div>
      <div className="border-b border-panel-border last:border-b-0 p-4 space-y-3">
        <h3 data-setting-target="manual-rebuild" className="font-medium text-primary">
          Manual rebuild
        </h3>
        <p className="text-sm text-muted">
          Rebuild or redeploy specific components without pulling from git. Useful after editing local code.
        </p>
        <div className="flex flex-wrap gap-3">
          {MANUAL_UPDATE_TARGETS.map((target) => (
            <label key={target} className="flex items-center gap-2 text-sm text-primary">
              <input
                type="checkbox"
                checked={selectedTargets.has(target)}
                onChange={() => canWriteUpdates && toggleTarget(target)}
                disabled={!canWriteUpdates || isApplying || rebuild.isPending}
              />
              {target}
            </label>
          ))}
        </div>
        <button
          className={clsx(
            'ficus-button',
            'px-4 py-2.5 md:py-2 rounded-md text-sm font-medium min-h-[44px] md:min-h-0 shrink-0',
            'bg-accent text-on-accent hover:bg-accent-hover active:bg-accent-active',
            'disabled:opacity-50 disabled:cursor-not-allowed'
          )}
          onClick={() => rebuild.mutate(Array.from(selectedTargets))}
          disabled={!canWriteUpdates || isApplying || rebuild.isPending || selectedTargets.size === 0}
        >
          {rebuild.isPending ? 'Rebuilding…' : 'Rebuild selected'}
        </button>
        {rebuild.error && <p className="text-sm text-danger">{formatUpdateError(rebuild.error)}</p>}
      </div>
      <div className="border-b border-panel-border last:border-b-0 p-4 min-w-0">
        <h3 data-setting-target="latest-run" className="font-medium text-primary">
          Latest run
        </h3>
        <p className="text-sm text-muted">
          Status: {latest?.status ?? 'none'} {latest?.message ? `— ${latest.message}` : ''}
        </p>
        {latest?.error && <p className="text-sm text-danger">{latest.error}</p>}
        {apply.error && <p className="text-sm text-danger">{formatUpdateError(apply.error)}</p>}
        {statusQuery.error && <p className="text-sm text-warning">{formatUpdateError(statusQuery.error)}</p>}
        <p className="text-sm text-muted">Tasks: {latest?.selectedTasks?.join(', ') || 'none'}</p>
        {latest?.changedFiles?.length ? (
          <div className="text-sm text-muted min-w-0">
            <p>Changed files:</p>
            <ul className="mt-1 list-disc pl-5 space-y-1">
              {latest.changedFiles.map((filePath, index) => (
                <li key={`${filePath}-${index}`} className="break-all">
                  {filePath}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {latest?.commands?.map((cmd, i) => {
          const output = `${cmd.command.join(' ')} — ${cmd.status}${cmd.note ? `\n${cmd.note}` : ''}${cmd.outputTail ? `\n${cmd.outputTail}` : ''}`
          return (
            <pre key={i} className="mt-2 p-2 overflow-auto rounded bg-background text-xs text-primary">
              <AnsiText>{output}</AnsiText>
            </pre>
          )
        })}
      </div>
    </section>
  )
}

function DesktopManagedNotice() {
  return (
    <section className="space-y-3 text-primary" data-testid="desktop-managed-notice">
      <h2 className="text-xl font-semibold text-primary">System Updates</h2>
      <p className="text-sm text-muted">
        This instance is managed by Tau Desktop. Update it from the app: choose Tau → Check for Updates… in the menu
        bar.
      </p>
    </section>
  )
}

function formatUpdateError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  if (message.includes('API error: 502') || message.includes('<!DOCTYPE html>')) {
    return 'The API is restarting or temporarily unavailable. Reconnecting…'
  }
  return message
}
