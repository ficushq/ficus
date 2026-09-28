import { useState, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { updateSquad } from '../../api/squads'
import { queries } from '../../queryOptions'
import { queryKeys } from '../../queryKeys'
import clsx from 'clsx'
import { FormSkeleton } from '../loading/Skeleton'

interface Props {
  squadId: string
}

interface SandboxConfig {
  alwaysOn: boolean
  idleTimeoutMinutes: number
  /** Per-squad ephemeral-storage limit in GiB. Undefined = use the global default. */
  ephemeralStorageLimitGi?: number
}

const DEFAULT_CONFIG: SandboxConfig = {
  alwaysOn: false,
  idleTimeoutMinutes: 60,
}

// Bounds mirror the backend clamp in pod-manager (resolveEphemeralStorageLimit).
const MIN_STORAGE_GI = 1
const MAX_STORAGE_GI = 200

export function SandboxSettings({ squadId }: Props) {
  const queryClient = useQueryClient()

  const { data: squad, isLoading } = useQuery(queries.squads.basic(squadId))

  const [config, setConfig] = useState<SandboxConfig>(DEFAULT_CONFIG)
  const [hasChanges, setHasChanges] = useState(false)

  // Reset form when squad data loads
  useEffect(() => {
    if (squad) {
      const sandbox = (squad.metadata as { sandbox?: Partial<SandboxConfig> } | undefined)?.sandbox
      setConfig({
        alwaysOn: sandbox?.alwaysOn === true, // default: false
        idleTimeoutMinutes: sandbox?.idleTimeoutMinutes ?? 60,
        ephemeralStorageLimitGi: sandbox?.ephemeralStorageLimitGi,
      })
      setHasChanges(false)
    }
  }, [squad])

  const updateMutation = useMutation({
    mutationFn: async (sandboxConfig: SandboxConfig) => {
      // Send `null` for an unset storage limit so the metadata deep-merge
      // deletes the key (reverting to the global default) rather than keeping a
      // stale override.
      return updateSquad(squadId, {
        metadata: {
          sandbox: {
            alwaysOn: sandboxConfig.alwaysOn,
            idleTimeoutMinutes: sandboxConfig.idleTimeoutMinutes,
            ephemeralStorageLimitGi: sandboxConfig.ephemeralStorageLimitGi ?? null,
          },
        },
      })
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.squads.basic(squadId) })
      queryClient.invalidateQueries({ queryKey: queryKeys.squads.detail(squadId) })
      setHasChanges(false)
    },
  })

  const handleSave = () => {
    updateMutation.mutate(config)
  }

  if (isLoading) {
    return <FormSkeleton label="Loading sandbox settings" sections={3} />
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <div>
          <h3 data-setting-target="sandbox-lifecycle" className="text-sm font-medium text-primary">
            Sandbox Lifecycle
          </h3>
          <p className="text-xs text-muted mt-1">
            Control whether the sandbox stays running or shuts down after a period of inactivity.
          </p>
        </div>
        {hasChanges && (
          <button
            onClick={handleSave}
            disabled={updateMutation.isPending}
            className="ficus-button ficus-button-primary px-3 py-1.5 text-sm rounded-md bg-accent text-on-accent hover:bg-accent/90"
          >
            {updateMutation.isPending ? 'Saving...' : 'Save Changes'}
          </button>
        )}
      </div>

      <div className="space-y-4">
        {/* Always On toggle */}
        <div className="border-b border-panel-border last:border-b-0 flex items-start gap-3 p-3">
          <button
            type="button"
            role="switch"
            aria-checked={config.alwaysOn}
            onClick={() => {
              setConfig((prev) => ({ ...prev, alwaysOn: !prev.alwaysOn }))
              setHasChanges(true)
            }}
            className={clsx(
              'ficus-button',
              'relative mt-0.5 inline-flex h-5 w-9 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors',
              config.alwaysOn ? 'bg-accent' : 'bg-surface-secondary'
            )}
          >
            <span
              className={clsx(
                'inline-block h-4 w-4 transform rounded-full transition-transform',
                // On the accent track the thumb takes the on-accent ink, like text on an accent button.
                config.alwaysOn ? 'translate-x-4 bg-on-accent' : 'translate-x-0 bg-chrome-toggle-thumb'
              )}
            />
          </button>
          <div className="flex-1">
            <div className="text-sm font-medium text-primary">Always On</div>
            <p className="text-xs text-muted mt-0.5">
              {config.alwaysOn
                ? 'Sandbox stays running indefinitely. Faster agent startup but uses more resources.'
                : 'Sandbox shuts down after idle timeout. Saves resources but agents have a cold-start delay.'}
            </p>
          </div>
        </div>

        {/* Idle timeout (only when not always-on) */}
        {!config.alwaysOn && (
          <div className="border-b border-panel-border last:border-b-0 p-3">
            <label
              data-setting-target="idle-timeout"
              htmlFor="idle-timeout"
              className="block text-sm font-medium text-primary mb-1"
            >
              Idle Timeout
            </label>
            <p className="text-xs text-muted mb-2">
              How long the sandbox stays running after the last activity before shutting down.
            </p>
            <div className="flex items-center gap-2">
              <input
                id="idle-timeout"
                type="number"
                min={5}
                max={1440}
                value={config.idleTimeoutMinutes}
                onChange={(e) => {
                  const val = parseInt(e.target.value, 10)
                  if (!isNaN(val) && val >= 1) {
                    setConfig((prev) => ({ ...prev, idleTimeoutMinutes: val }))
                    setHasChanges(true)
                  }
                }}
                className="ficus-field w-24 px-3 py-1.5 text-sm rounded border border-th-border bg-surface text-primary  focus:ring-1 focus:ring-accent/50"
              />
              <span className="text-sm text-muted">minutes</span>
            </div>
          </div>
        )}

        {/* Ephemeral storage limit override */}
        <div className="border-b border-panel-border last:border-b-0 p-3">
          <label
            data-setting-target="ephemeral-storage-limit"
            htmlFor="ephemeral-storage"
            className="block text-sm font-medium text-primary mb-1"
          >
            Ephemeral Storage Limit
          </label>
          <p className="text-xs text-muted mb-2">
            Per-squad disk limit for the sandbox pod (toolchains, build output, Docker layers). Raise this for squads
            with heavy toolchains whose install exceeds the default. Leave empty to use the global default.
          </p>
          <div className="flex items-center gap-2">
            <input
              id="ephemeral-storage"
              type="number"
              min={MIN_STORAGE_GI}
              max={MAX_STORAGE_GI}
              placeholder="Default"
              value={config.ephemeralStorageLimitGi ?? ''}
              onChange={(e) => {
                const raw = e.target.value.trim()
                if (raw === '') {
                  setConfig((prev) => ({ ...prev, ephemeralStorageLimitGi: undefined }))
                  setHasChanges(true)
                  return
                }
                const val = parseInt(raw, 10)
                if (!isNaN(val) && val >= MIN_STORAGE_GI && val <= MAX_STORAGE_GI) {
                  setConfig((prev) => ({ ...prev, ephemeralStorageLimitGi: val }))
                  setHasChanges(true)
                }
              }}
              className="ficus-field w-24 px-3 py-1.5 text-sm rounded border border-th-border bg-surface text-primary  focus:ring-1 focus:ring-accent/50"
            />
            <span className="text-sm text-muted">GiB</span>
          </div>
        </div>
      </div>

      {updateMutation.isError && (
        <p className="text-xs text-status-danger-500 mt-2">Failed to save: {String(updateMutation.error)}</p>
      )}
      {!hasChanges && updateMutation.isSuccess && (
        <p className="text-xs text-status-success-500 mt-2">
          ✓ Saved. Changes take effect on the next sandbox restart or reconciliation cycle.
        </p>
      )}
    </div>
  )
}
