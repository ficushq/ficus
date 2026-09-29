import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { queries } from '../../queryOptions'
import { queryKeys } from '../../queryKeys'
import { addPeer, removePeer, updatePeer } from '../../api/amtp'
import { usePermissions } from '../../hooks/usePermissions'
import { useLoadingShapeCount } from '../../hooks/useLoadingShapeCount'
import { LoadingSurface, SkeletonLine, SkeletonRows } from '../loading/Skeleton'

export function AmtpSection() {
  const qc = useQueryClient()
  const { can } = usePermissions()
  const canWrite = can('amtp:write')
  const identity = useQuery(queries.amtp.identity())
  const peers = useQuery(queries.amtp.peers())
  const peerSkeletonCount = useLoadingShapeCount(
    'settings:federation-peers',
    peers.isSuccess ? (peers.data?.length ?? 0) : undefined,
    { fallbackCount: 2, maxCount: 8 }
  )
  const [form, setForm] = useState({ localAlias: '', instanceId: '', baseUrl: '', publicKeyPem: '' })
  const [addError, setAddError] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editForm, setEditForm] = useState<{ localAlias: string; baseUrl: string; status: 'active' | 'disabled' }>({
    localAlias: '',
    baseUrl: '',
    status: 'active',
  })

  const invalidatePeers = () => qc.invalidateQueries({ queryKey: queryKeys.amtp.peers() })

  const add = useMutation({
    mutationFn: () => addPeer(form),
    onSuccess: () => {
      setAddError(null)
      setForm({ localAlias: '', instanceId: '', baseUrl: '', publicKeyPem: '' })
      invalidatePeers()
    },
    onError: (err: unknown) => setAddError(err instanceof Error ? err.message : 'Failed to add peer'),
  })

  const remove = useMutation({ mutationFn: (id: string) => removePeer(id), onSuccess: invalidatePeers })

  const edit = useMutation({
    mutationFn: (id: string) =>
      updatePeer(id, { localAlias: editForm.localAlias, baseUrl: editForm.baseUrl, status: editForm.status }),
    onSuccess: () => {
      setEditingId(null)
      invalidatePeers()
    },
  })

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-semibold text-primary">Federation</h3>
        <p className="mt-1 text-sm text-muted">View this instance's identity and manage federation peers.</p>
      </div>

      <div className="ficus-section py-5">
        <h4 data-setting-target="this-instance" className="text-md mb-4 font-medium text-primary">
          This Instance
        </h4>
        <div className="space-y-2 text-sm">
          <div className="flex flex-col gap-0.5">
            <span className="text-xs font-medium uppercase tracking-wider text-secondary">Instance ID</span>
            {identity.isLoading ? (
              <LoadingSurface label="Loading instance ID">
                <SkeletonLine className="h-4 w-64 max-w-full" />
              </LoadingSurface>
            ) : (
              <span className="break-all font-mono text-primary">{identity.data?.instanceId ?? '—'}</span>
            )}
          </div>
          <div className="flex flex-col gap-0.5">
            <span className="text-xs font-medium uppercase tracking-wider text-secondary">Public Key</span>
            {identity.isLoading ? (
              <LoadingSurface label="Loading public key" className="space-y-1.5">
                <SkeletonLine className="h-3 w-full" />
                <SkeletonLine className="h-3 w-4/5" />
              </LoadingSurface>
            ) : (
              <span className="break-all font-mono text-xs text-primary">{identity.data?.publicKeyPem ?? '—'}</span>
            )}
          </div>
        </div>
      </div>

      <div className="ficus-section overflow-hidden">
        <div className="border-b border-th-border px-4 py-3">
          <h4 data-setting-target="peers" className="text-sm font-medium text-secondary">
            Peers
          </h4>
        </div>
        <div className="divide-y divide-th-border">
          {peers.isLoading && (
            <LoadingSurface label="Loading federation peers">
              <SkeletonRows count={Math.max(1, peerSkeletonCount)}>
                {(index) => (
                  <div key={index} className="space-y-2 border-b border-th-border px-4 py-3 last:border-b-0">
                    <SkeletonLine className={index % 2 ? 'w-32' : 'w-44'} />
                    <SkeletonLine className="w-3/5" />
                  </div>
                )}
              </SkeletonRows>
            </LoadingSurface>
          )}
          {!peers.isLoading && (peers.data ?? []).length === 0 && (
            <div className="px-4 py-3 text-sm text-muted">No peers configured.</div>
          )}
          {(peers.data ?? []).map((p) =>
            editingId === p.id ? (
              <form
                key={p.id}
                className="space-y-2 px-4 py-3"
                onSubmit={(e) => {
                  e.preventDefault()
                  edit.mutate(p.id)
                }}
              >
                <input
                  type="text"
                  value={editForm.localAlias}
                  onChange={(e) => setEditForm({ ...editForm, localAlias: e.target.value })}
                  aria-label="Alias"
                  className="ficus-field w-full rounded border border-th-border bg-surface-secondary px-2 py-1 text-sm text-primary  focus:ring-1 focus:ring-accent"
                />
                <input
                  type="url"
                  value={editForm.baseUrl}
                  onChange={(e) => setEditForm({ ...editForm, baseUrl: e.target.value })}
                  aria-label="Base URL"
                  className="ficus-field w-full rounded border border-th-border bg-surface-secondary px-2 py-1 text-sm text-primary  focus:ring-1 focus:ring-accent"
                />
                <select
                  value={editForm.status}
                  onChange={(e) => setEditForm({ ...editForm, status: e.target.value as 'active' | 'disabled' })}
                  aria-label="Status"
                  className="ficus-field rounded border border-th-border bg-surface-secondary px-2 py-1 text-sm text-primary  focus:ring-1 focus:ring-accent"
                >
                  <option value="active">active</option>
                  <option value="disabled">disabled</option>
                </select>
                <div className="flex gap-2">
                  <button
                    type="submit"
                    disabled={edit.isPending}
                    className="ficus-button ficus-button-primary rounded bg-accent px-3 py-1 text-xs font-medium text-on-accent hover:bg-accent-hover disabled:opacity-50"
                  >
                    {edit.isPending ? 'Saving…' : 'Save'}
                  </button>
                  <button
                    type="button"
                    onClick={() => setEditingId(null)}
                    className="ficus-button ficus-button-secondary px-3 py-1 text-xs"
                  >
                    Cancel
                  </button>
                </div>
              </form>
            ) : (
              <div key={p.id} className="flex items-center justify-between gap-2 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-primary">{p.localAlias}</p>
                  <p className="truncate text-xs text-muted">{p.baseUrl}</p>
                  <p className="text-xs text-muted">Status: {p.status}</p>
                </div>
                {canWrite && (
                  <div className="flex shrink-0 items-center gap-2">
                    <button
                      onClick={() => {
                        setEditingId(p.id)
                        setEditForm({
                          localAlias: p.localAlias,
                          baseUrl: p.baseUrl,
                          status: p.status === 'disabled' ? 'disabled' : 'active',
                        })
                      }}
                      className="ficus-button text-sm font-medium text-accent-light hover:text-link-hover"
                    >
                      Edit
                    </button>
                    <span className="text-muted">·</span>
                    <button
                      onClick={() => {
                        if (confirm(`Remove peer ${p.localAlias}? This cannot be undone.`)) remove.mutate(p.id)
                      }}
                      disabled={remove.isPending}
                      className="ficus-button text-sm font-medium text-status-danger-600 hover:text-status-danger-800 disabled:opacity-50 dark:text-status-danger-400 dark:hover:text-status-danger-300"
                    >
                      Remove
                    </button>
                  </div>
                )}
              </div>
            )
          )}
        </div>
      </div>

      {canWrite && (
        <div className="ficus-section overflow-hidden">
          <div className="border-b border-th-border px-4 py-3">
            <h4 className="text-sm font-medium text-secondary">Add Peer</h4>
          </div>
          <form
            className="space-y-3 px-4 py-3"
            onSubmit={(e) => {
              e.preventDefault()
              add.mutate()
            }}
          >
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <div>
                <label className="mb-1 block text-xs font-medium text-secondary">Alias</label>
                <input
                  type="text"
                  value={form.localAlias}
                  onChange={(e) => setForm({ ...form, localAlias: e.target.value })}
                  placeholder="e.g. acme"
                  className="ficus-field w-full rounded border border-th-border bg-surface-secondary px-2 py-1 text-sm text-primary placeholder:text-placeholder  focus:ring-1 focus:ring-accent"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-secondary">Instance ID</label>
                <input
                  type="text"
                  value={form.instanceId}
                  onChange={(e) => setForm({ ...form, instanceId: e.target.value })}
                  placeholder="Remote instance ID"
                  className="ficus-field w-full rounded border border-th-border bg-surface-secondary px-2 py-1 text-sm text-primary placeholder:text-placeholder  focus:ring-1 focus:ring-accent"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-secondary">Base URL</label>
                <input
                  type="url"
                  value={form.baseUrl}
                  onChange={(e) => setForm({ ...form, baseUrl: e.target.value })}
                  placeholder="https://peer.example.com/api"
                  className="ficus-field w-full rounded border border-th-border bg-surface-secondary px-2 py-1 text-sm text-primary placeholder:text-placeholder  focus:ring-1 focus:ring-accent"
                />
              </div>
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-secondary">Public Key (PEM)</label>
              <textarea
                value={form.publicKeyPem}
                onChange={(e) => setForm({ ...form, publicKeyPem: e.target.value })}
                placeholder="-----BEGIN PUBLIC KEY-----"
                rows={4}
                className="ficus-field w-full rounded border border-th-border bg-surface-secondary px-2 py-1 font-mono text-sm text-primary placeholder:text-placeholder  focus:ring-1 focus:ring-accent"
              />
            </div>
            {addError && <p className="text-xs text-status-danger-600 dark:text-status-danger-400">{addError}</p>}
            <button
              type="submit"
              disabled={add.isPending || !form.localAlias || !form.instanceId || !form.baseUrl || !form.publicKeyPem}
              className="ficus-button ficus-button-primary rounded bg-accent px-3 py-1 text-xs font-medium text-on-accent hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
            >
              {add.isPending ? 'Adding…' : 'Add Peer'}
            </button>
          </form>
        </div>
      )}
    </div>
  )
}
