import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { runNixGc, runWorkspaceGc } from '../../../api/system'
import { ConfirmStorageAction } from './ConfirmStorageAction'
import { storageSize } from './format'

const reclaimable = (result: Awaited<ReturnType<typeof runNixGc>>) =>
  result.candidates.filter((candidate) => candidate.verdict !== 'live' && !candidate.running)

/** Existing operator cleanups on the Ficus host (system:cleanup): scan first, then confirm what is removed. */
export function HostCleanupSection({ onDone }: { onDone: (message: string) => void }) {
  const nixScan = useMutation({ mutationFn: () => runNixGc(false) })
  const workspaceScan = useMutation({ mutationFn: () => runWorkspaceGc(false) })
  const [confirm, setConfirm] = useState<'nix' | 'workspace' | null>(null)
  const nix = nixScan.data
  const nixStores = nix ? reclaimable(nix) : []
  const workspace = workspaceScan.data
  return (
    <section className="space-y-4" aria-labelledby="host-cleanup-heading">
      <div>
        <h3 id="host-cleanup-heading" className="font-medium text-primary">
          Ficus host cleanup
        </h3>
        <p className="mt-1 text-sm text-secondary">
          Scan first; nothing is removed until you confirm. These act on the server running Ficus.
        </p>
      </div>

      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="ficus-button ficus-button-secondary px-3 py-1.5 text-sm"
            disabled={nixScan.isPending}
            onClick={() => nixScan.mutate()}
          >
            {nixScan.isPending ? 'Scanning…' : 'Scan Nix stores'}
          </button>
          {nix && nixStores.length > 0 && (
            <button
              type="button"
              className="ficus-button ficus-button-danger px-3 py-1.5 text-sm"
              onClick={() => setConfirm('nix')}
            >
              Reclaim {storageSize(nix.totalReclaimableBytes)}…
            </button>
          )}
        </div>
        {nix && (
          <p role="status" className="text-sm text-secondary">
            {nix.candidates.length} agent Nix store{nix.candidates.length === 1 ? '' : 's'}; {nixStores.length} can be
            reclaimed ({storageSize(nix.totalReclaimableBytes)}).
          </p>
        )}
        {nixScan.isError && <p className="text-sm text-status-danger-400">{nixScan.error.message}</p>}
      </div>

      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="ficus-button ficus-button-secondary px-3 py-1.5 text-sm"
            disabled={workspaceScan.isPending}
            onClick={() => workspaceScan.mutate()}
          >
            {workspaceScan.isPending ? 'Scanning…' : 'Scan empty workspace folders'}
          </button>
          {workspace && workspace.eligible > 0 && (
            <button
              type="button"
              className="ficus-button ficus-button-danger px-3 py-1.5 text-sm"
              onClick={() => setConfirm('workspace')}
            >
              Remove {workspace.eligible} empty folder{workspace.eligible === 1 ? '' : 's'}…
            </button>
          )}
        </div>
        {workspace && (
          <p role="status" className="text-sm text-secondary">
            Scanned {workspace.scanned} workspace folder{workspace.scanned === 1 ? '' : 's'}; {workspace.eligible} empty
            folder{workspace.eligible === 1 ? '' : 's'} left by deleted squads can be removed.
            {workspace.hasMore ? ' More folders remain; scan again after removing these.' : ''}
          </p>
        )}
        {workspaceScan.isError && <p className="text-sm text-status-danger-400">{workspaceScan.error.message}</p>}
      </div>

      <ConfirmStorageAction
        isOpen={confirm === 'nix'}
        onClose={() => setConfirm(null)}
        danger
        title="Reclaim Nix stores"
        confirmLabel="Reclaim"
        action={() => runNixGc(true)}
        onDone={(result) => {
          nixScan.reset()
          onDone(
            `Reclaimed ${result.reclaimed?.length ?? 0} Nix store(s)${result.failed?.length ? `; ${result.failed.length} failed` : ''}.`
          )
        }}
      >
        <p>
          Deletes the Nix stores of {nixStores.length} orphaned or terminated agent{nixStores.length === 1 ? '' : 's'}{' '}
          on the Ficus host, freeing about {storageSize(nix?.totalReclaimableBytes ?? 0)}.
        </p>
        <p>Stores of live or dormant agents and of running sandboxes are never touched.</p>
      </ConfirmStorageAction>

      <ConfirmStorageAction
        isOpen={confirm === 'workspace'}
        onClose={() => setConfirm(null)}
        danger
        title="Remove empty workspace folders"
        confirmLabel="Remove"
        action={() => runWorkspaceGc(true)}
        onDone={(result) => {
          workspaceScan.reset()
          onDone(
            `Removed ${result.removed} empty workspace folder(s).${result.hasMore ? ' More remain; scan again.' : ''}`
          )
        }}
      >
        <p>
          Removes {workspace?.eligible ?? 0} empty workspace folder{workspace?.eligible === 1 ? '' : 's'} left by
          deleted squads on the Ficus host.
        </p>
        <p>Only empty folders are removed, so this frees almost no space; it tidies the workspace root.</p>
      </ConfirmStorageAction>
    </section>
  )
}
