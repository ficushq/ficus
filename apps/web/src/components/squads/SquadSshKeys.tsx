import { useState, useCallback } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { listSshKeys, addSshKey, getSshPublicKey, deleteSshKey, type SshKey } from '../../api/squads'
import { ConfirmButton } from '../ConfirmButton'
import clsx from 'clsx'
import { usePermissions } from '../../hooks/usePermissions'
import { useLoadingShapeCount } from '../../hooks/useLoadingShapeCount'
import { CollectionSkeleton } from '../loading/Skeleton'

interface Props {
  squadId: string
}

export function SquadSshKeys({ squadId }: Props) {
  const queryClient = useQueryClient()
  const [showAddForm, setShowAddForm] = useState(false)
  const [keyName, setKeyName] = useState('')
  const [privateKey, setPrivateKey] = useState('')
  const [publicKey, setPublicKey] = useState('')
  const [copiedKey, setCopiedKey] = useState<string | null>(null)
  const { can, isLoading: permissionsLoading } = usePermissions(squadId)
  const canWriteSsh = !permissionsLoading && can('ssh:write')

  const queryKey = ['squads', squadId, 'ssh-keys']

  const {
    data: keys = [],
    isLoading,
    isSuccess,
  } = useQuery({
    queryKey,
    queryFn: () => listSshKeys(squadId),
  })
  const keySkeletonCount = useLoadingShapeCount(`squads:${squadId}:ssh-keys`, isSuccess ? keys.length : undefined, {
    fallbackCount: 2,
    maxCount: 8,
  })

  const addMutation = useMutation({
    mutationFn: (input: { name: string; privateKey: string; publicKey?: string }) => addSshKey(squadId, input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey })
      setShowAddForm(false)
      setKeyName('')
      setPrivateKey('')
      setPublicKey('')
    },
  })

  const deleteMutation = useMutation({
    mutationFn: (keyName: string) => deleteSshKey(squadId, keyName),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey })
    },
  })

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault()
      if (!keyName.trim() || !privateKey.trim()) return
      addMutation.mutate({
        name: keyName.trim(),
        privateKey: privateKey.trim(),
        publicKey: publicKey.trim() || undefined,
      })
    },
    [keyName, privateKey, publicKey, addMutation]
  )

  const handleCopyPublicKey = useCallback(
    async (key: SshKey) => {
      try {
        const pubKey = await getSshPublicKey(squadId, key.name)
        await navigator.clipboard.writeText(pubKey)
        setCopiedKey(key.name)
        setTimeout(() => setCopiedKey(null), 2000)
      } catch (err) {
        console.error('Failed to copy public key:', err)
      }
    },
    [squadId]
  )

  const validateKeyName = (name: string) => /^[a-zA-Z0-9_-]+$/.test(name)

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <div>
          <h3 data-setting-target="ssh-keys" className="text-sm font-medium text-primary">
            SSH Keys
          </h3>
          <p className="text-xs text-muted mt-1">
            Manage SSH keys for this squad's workspace. Keys are used for git operations.
          </p>
        </div>
        {canWriteSsh && !showAddForm && (
          <button
            onClick={() => setShowAddForm(true)}
            className="ficus-button ficus-button-primary px-3 py-1.5 text-sm rounded-md font-medium bg-accent text-on-accent hover:bg-accent/90 transition-colors"
          >
            Add Key
          </button>
        )}
      </div>

      {/* Key List */}
      {isLoading ? (
        <CollectionSkeleton label="Loading SSH keys" count={keySkeletonCount} />
      ) : keys.length === 0 && !showAddForm ? (
        <div className="text-sm text-muted py-4 text-center border border-dashed border-th-border rounded-lg">
          No SSH keys configured
        </div>
      ) : (
        <div className="space-y-2 mb-4">
          {keys.map((key) => (
            <div
              key={key.name}
              className="border-b border-panel-border last:border-b-0 flex items-center justify-between p-3"
            >
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded bg-surface-secondary flex items-center justify-center">
                  <svg className="w-4 h-4 text-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z"
                    />
                  </svg>
                </div>
                <div>
                  <span className="text-sm font-medium text-primary">{key.name}</span>
                  {key.type && <span className="text-xs text-muted ml-2">({key.type})</span>}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => handleCopyPublicKey(key)}
                  className="ficus-button px-2 py-1 text-xs rounded border border-th-border text-secondary hover:bg-surface-hover transition-colors"
                >
                  {copiedKey === key.name ? '✓ Copied' : 'Copy Public Key'}
                </button>
                {canWriteSsh && (
                  <ConfirmButton
                    onConfirm={() => deleteMutation.mutate(key.name)}
                    label="Delete"
                    confirmLabel="Confirm?"
                    className="ficus-button px-2 py-1 text-xs rounded border border-status-danger-300 dark:border-status-danger-800 text-status-danger-600 dark:text-status-danger-400 hover:bg-status-danger-50 dark:hover:bg-status-danger-900/20 transition-colors"
                    confirmClassName="px-2 py-1 text-xs rounded border border-status-danger-500 bg-status-danger-50 dark:bg-status-danger-900/30 text-status-danger-700 dark:text-status-danger-300 transition-colors"
                    disabled={deleteMutation.isPending}
                  />
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Add Key Form */}
      {canWriteSsh && showAddForm && (
        <form onSubmit={handleSubmit} className="ficus-inset p-4">
          <h4 className="text-sm font-medium text-primary mb-3">Add SSH Key</h4>

          <div className="space-y-4">
            <div>
              <label className="block text-xs font-medium text-secondary mb-1">Key Name</label>
              <input
                type="text"
                value={keyName}
                onChange={(e) => setKeyName(e.target.value)}
                placeholder="my-deploy-key"
                className={clsx(
                  'ficus-field',
                  'w-full px-3 py-2 text-sm rounded-md border bg-surface text-primary',
                  'placeholder:text-placeholder',
                  ' focus:ring-2 focus:ring-accent/50 focus:border-accent',
                  keyName && !validateKeyName(keyName) ? 'border-status-danger-500' : 'border-th-border'
                )}
              />
              {keyName && !validateKeyName(keyName) && (
                <p className="text-xs text-status-danger-500 mt-1">
                  Only alphanumeric characters, hyphens, and underscores
                </p>
              )}
            </div>

            <div>
              <label className="block text-xs font-medium text-secondary mb-1">
                Private Key <span className="text-status-danger-500">*</span>
              </label>
              <textarea
                value={privateKey}
                onChange={(e) => setPrivateKey(e.target.value)}
                placeholder="-----BEGIN OPENSSH PRIVATE KEY-----&#10;...&#10;-----END OPENSSH PRIVATE KEY-----"
                rows={6}
                className={clsx(
                  'ficus-field',
                  'w-full px-3 py-2 text-sm rounded-md border bg-surface text-primary font-mono',
                  'placeholder:text-placeholder',
                  ' focus:ring-2 focus:ring-accent/50 focus:border-accent',
                  'border-th-border'
                )}
              />
              <p className="text-xs text-muted mt-1">Paste the private key in PEM format. Never shared or displayed.</p>
            </div>

            <div>
              <label className="block text-xs font-medium text-secondary mb-1">Public Key (optional)</label>
              <textarea
                value={publicKey}
                onChange={(e) => setPublicKey(e.target.value)}
                placeholder="ssh-ed25519 AAAA... comment"
                rows={2}
                className={clsx(
                  'ficus-field',
                  'w-full px-3 py-2 text-sm rounded-md border bg-surface text-primary font-mono',
                  'placeholder:text-placeholder',
                  ' focus:ring-2 focus:ring-accent/50 focus:border-accent',
                  'border-th-border'
                )}
              />
              <p className="text-xs text-muted mt-1">If not provided, it will be derived from the private key.</p>
            </div>
          </div>

          <div className="flex items-center justify-end gap-2 mt-4">
            <button
              type="button"
              onClick={() => {
                setShowAddForm(false)
                setKeyName('')
                setPrivateKey('')
                setPublicKey('')
              }}
              className="ficus-button px-3 py-1.5 text-sm rounded-md font-medium text-secondary hover:bg-surface-hover transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!keyName.trim() || !privateKey.trim() || !validateKeyName(keyName) || addMutation.isPending}
              className={clsx(
                'ficus-button',
                'px-4 py-1.5 text-sm rounded-md font-medium transition-colors',
                keyName.trim() && privateKey.trim() && validateKeyName(keyName)
                  ? 'bg-accent text-on-accent hover:bg-accent/90'
                  : 'bg-surface-secondary text-muted cursor-not-allowed'
              )}
            >
              {addMutation.isPending ? 'Adding...' : 'Add Key'}
            </button>
          </div>

          {addMutation.isError && (
            <p className="text-xs text-status-danger-500 mt-2">Failed to add key: {String(addMutation.error)}</p>
          )}
        </form>
      )}
    </div>
  )
}
