import { SquadWorkflowSettings } from './SquadWorkflowSettings'
import { useState, useCallback, useEffect } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { updateSquad } from '../../api/squads'
import { queryKeys } from '../../queryKeys'
import { queries } from '../../queryOptions'
import clsx from 'clsx'
import { usePermissions } from '../../hooks/usePermissions'
import { SquadAvatarSettings } from './SquadAvatarSettings'
import { updateSquadSchema, type UpdateSquadInput } from '@ficus/shared'

type SettingsSection = 'general' | 'workflows' | 'workspace'

interface Props {
  section?: SettingsSection
  squadId: string
  name: string
  purpose: string
  globalCollaborationEnabled: boolean
  maxConcurrentWorkStreams: number | null
  blockedGraceMinutes: number | null
  hostWorkspacePath: string | null
}

export function parseBlockedGraceMinutes(raw: string): number | null | undefined {
  const trimmed = raw.trim()
  if (trimmed === '') return null
  const value = Number(trimmed)
  return Number.isInteger(value) ? value : undefined
}

export function blockedGraceMinutesError(value: number | null): string | null {
  const parsed = updateSquadSchema.safeParse({ blockedGraceMinutes: value })
  if (parsed.success) return null
  return parsed.error.issues.find((issue) => issue.path[0] === 'blockedGraceMinutes')?.message ?? 'Invalid grace period'
}

export function hostWorkspacePathError(value: string | null): string | null {
  const parsed = updateSquadSchema.safeParse({ hostWorkspacePath: value })
  if (parsed.success) return null
  // Nothing expands `~` on this path: the browser cannot know the Ficus host's
  // home directory, so the literal characters would reach the server. Say
  // that, rather than the schema's generic "must be an absolute path".
  if (value?.startsWith('~')) return 'Enter the full absolute path; `~` is not expanded here.'
  return parsed.error.issues.find((issue) => issue.path[0] === 'hostWorkspacePath')?.message ?? 'Invalid path'
}

export function buildSquadGeneralSettingsUpdate(input: {
  name: string
  purpose: string
  globalCollaborationEnabled: boolean
  maxConcurrentWorkStreams: number | null
  blockedGraceMinutes: number | null
  hostWorkspacePath: string | null
}): UpdateSquadInput {
  return {
    name: input.name.trim(),
    purpose: input.purpose.trim(),
    globalCollaborationEnabled: input.globalCollaborationEnabled,
    maxConcurrentWorkStreams: input.maxConcurrentWorkStreams,
    blockedGraceMinutes: input.blockedGraceMinutes,
    hostWorkspacePath: input.hostWorkspacePath,
  }
}

export function SquadGeneralSettings({
  section = 'general',
  squadId,
  name,
  purpose,
  globalCollaborationEnabled,
  maxConcurrentWorkStreams,
  blockedGraceMinutes,
  hostWorkspacePath,
}: Props) {
  const [nameValue, setNameValue] = useState(name)
  const [purposeValue, setPurposeValue] = useState(purpose)
  const [globalCollaborationEnabledValue, setGlobalCollaborationEnabledValue] = useState(globalCollaborationEnabled)
  const [maxConcurrentWorkStreamsValue, setMaxConcurrentWorkStreamsValue] = useState(maxConcurrentWorkStreams)
  const [blockedGraceMinutesValue, setBlockedGraceMinutesValue] = useState(blockedGraceMinutes)
  const [hostWorkspacePathValue, setHostWorkspacePathValue] = useState(hostWorkspacePath)
  const [saved, setSaved] = useState(false)
  const queryClient = useQueryClient()
  const { can, isLoading: permissionsLoading } = usePermissions(squadId)
  const canUpdateSquad = !permissionsLoading && can('squads:update')
  const { data: sandboxStatus } = useQuery(queries.sandbox.status(squadId))
  const isHostRuntime = sandboxStatus?.runtime === 'host'

  // Sync when props change (e.g. from another tab)
  useEffect(() => {
    setNameValue(name)
    setPurposeValue(purpose)
    setGlobalCollaborationEnabledValue(globalCollaborationEnabled)
    setMaxConcurrentWorkStreamsValue(maxConcurrentWorkStreams)
    setBlockedGraceMinutesValue(blockedGraceMinutes)
    setHostWorkspacePathValue(hostWorkspacePath)
  }, [name, purpose, globalCollaborationEnabled, maxConcurrentWorkStreams, blockedGraceMinutes, hostWorkspacePath])

  const dirty =
    section === 'general'
      ? nameValue !== name || purposeValue !== purpose || globalCollaborationEnabledValue !== globalCollaborationEnabled
      : section === 'workflows'
        ? maxConcurrentWorkStreamsValue !== maxConcurrentWorkStreams || blockedGraceMinutesValue !== blockedGraceMinutes
        : hostWorkspacePathValue !== hostWorkspacePath
  const graceError = blockedGraceMinutesError(blockedGraceMinutesValue)
  const hostError = hostWorkspacePathError(hostWorkspacePathValue)
  const isValid =
    section === 'general'
      ? nameValue.trim().length > 0 && purposeValue.trim().length > 0
      : section === 'workflows'
        ? graceError === null
        : hostError === null

  const mutation = useMutation({
    mutationFn: (input: UpdateSquadInput) => updateSquad(squadId, input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.squads.detail(squadId) })
      queryClient.invalidateQueries({ queryKey: queryKeys.squads.all })
      // The host workspace path lives in the sandbox status too (it reports the
      // path actually applied), so a save must refetch it or the "Active:" note
      // keeps describing the pre-save answer.
      queryClient.invalidateQueries({ queryKey: queryKeys.sandbox.status(squadId) })
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    },
  })

  const handleSave = useCallback(() => {
    if (!isValid) return
    mutation.mutate(
      section === 'general'
        ? {
            name: nameValue.trim(),
            purpose: purposeValue.trim(),
            globalCollaborationEnabled: globalCollaborationEnabledValue,
          }
        : section === 'workflows'
          ? { maxConcurrentWorkStreams: maxConcurrentWorkStreamsValue, blockedGraceMinutes: blockedGraceMinutesValue }
          : { hostWorkspacePath: hostWorkspacePathValue }
    )
  }, [
    section,
    nameValue,
    purposeValue,
    globalCollaborationEnabledValue,
    maxConcurrentWorkStreamsValue,
    blockedGraceMinutesValue,
    hostWorkspacePathValue,
    isValid,
    mutation,
  ])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault()
        if (dirty && isValid) handleSave()
      }
    },
    [dirty, isValid, handleSave]
  )

  return (
    <div>
      {section === 'general' && <SquadAvatarSettings squadId={squadId} name={name} />}
      {section === 'workflows' && <SquadWorkflowSettings squadId={squadId} canEdit={canUpdateSquad} />}
      <div className="mb-4">
        <h3 className="text-sm font-medium text-primary">
          {section === 'general' ? 'General' : section === 'workflows' ? 'Work capacity' : 'Workspace directory'}
        </h3>
        <p className="text-xs text-muted mt-1">
          {section === 'general'
            ? 'The squad’s identity and how other squads discover it.'
            : section === 'workflows'
              ? 'Control how much work runs at once and when waiting work frees a slot.'
              : 'Choose where this squad works on the Ficus host.'}
        </p>
      </div>

      <div className="space-y-4">
        {section === 'general' && (
          <>
            {/* Name Field */}
            <div>
              <label
                data-setting-target="name"
                htmlFor="squad-name"
                className="block text-sm font-medium text-primary mb-1"
              >
                Name
              </label>
              <input
                id="squad-name"
                type="text"
                value={nameValue}
                onChange={(e) => setNameValue(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Squad name"
                className={clsx(
                  'ficus-field',
                  'w-full px-3 py-2 rounded-lg border bg-surface text-primary text-sm',
                  'placeholder:text-placeholder',
                  ' focus:ring-2 focus:ring-accent/50 focus:border-accent',
                  nameValue !== name ? 'border-status-review-500 dark:border-status-review-400' : 'border-th-border'
                )}
              />
            </div>

            {/* Purpose/Description Field */}
            <div>
              <label
                data-setting-target="description"
                htmlFor="squad-purpose"
                className="block text-sm font-medium text-primary mb-1"
              >
                Description
              </label>
              <textarea
                id="squad-purpose"
                value={purposeValue}
                onChange={(e) => setPurposeValue(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="What is this squad's purpose?"
                rows={3}
                className={clsx(
                  'ficus-field',
                  'w-full px-3 py-2 rounded-lg border bg-surface text-primary text-sm',
                  'leading-relaxed resize-y',
                  'placeholder:text-placeholder',
                  ' focus:ring-2 focus:ring-accent/50 focus:border-accent',
                  purposeValue !== purpose
                    ? 'border-status-review-500 dark:border-status-review-400'
                    : 'border-th-border'
                )}
              />
            </div>
          </>
        )}
        {section === 'workflows' && (
          <>
            {/* Max Concurrent Work Streams */}
            <div>
              <label
                data-setting-target="max-concurrent-work-streams"
                htmlFor="squad-max-concurrent-work-streams"
                className="block text-sm font-medium text-primary mb-1"
              >
                Max concurrent work streams
              </label>
              <input
                id="squad-max-concurrent-work-streams"
                type="number"
                min={1}
                placeholder="Unlimited"
                value={maxConcurrentWorkStreamsValue ?? ''}
                onChange={(e) => {
                  const raw = e.target.value.trim()
                  if (raw === '') {
                    setMaxConcurrentWorkStreamsValue(null)
                    return
                  }
                  const val = parseInt(raw, 10)
                  if (!isNaN(val) && val >= 1) {
                    setMaxConcurrentWorkStreamsValue(val)
                  }
                }}
                className={clsx(
                  'ficus-field',
                  'w-32 px-3 py-2 rounded-lg border bg-surface text-primary text-sm',
                  'placeholder:text-placeholder',
                  ' focus:ring-2 focus:ring-accent/50 focus:border-accent',
                  maxConcurrentWorkStreamsValue !== maxConcurrentWorkStreams
                    ? 'border-status-review-500 dark:border-status-review-400'
                    : 'border-th-border'
                )}
              />
              <p className="text-xs text-muted mt-1">
                Streams beyond this limit queue until a slot frees. Empty = unlimited.
              </p>
            </div>

            {/* Auto-park Grace */}
            <div>
              <label
                data-setting-target="auto-park-grace-minutes"
                htmlFor="squad-blocked-grace-minutes"
                className="block text-sm font-medium text-primary mb-1"
              >
                Auto-park grace (minutes)
              </label>
              <input
                id="squad-blocked-grace-minutes"
                type="number"
                min={0}
                step={1}
                placeholder="30"
                value={blockedGraceMinutesValue ?? ''}
                onInput={(e) => {
                  const value = parseBlockedGraceMinutes(e.currentTarget.value)
                  if (value !== undefined) setBlockedGraceMinutesValue(value)
                }}
                aria-invalid={graceError !== null}
                aria-describedby="squad-blocked-grace-minutes-help"
                className={clsx(
                  'ficus-field',
                  'w-32 px-3 py-2 rounded-lg border bg-surface text-primary text-sm',
                  'placeholder:text-placeholder',
                  ' focus:ring-2 focus:ring-accent/50 focus:border-accent',
                  graceError
                    ? 'border-status-danger-500 dark:border-status-danger-400'
                    : blockedGraceMinutesValue !== blockedGraceMinutes
                      ? 'border-status-review-500 dark:border-status-review-400'
                      : 'border-th-border'
                )}
              />
              <p id="squad-blocked-grace-minutes-help" className="text-xs text-muted mt-1">
                Blocked streams release their slot after this long; empty = 30. Changes take effect live.
              </p>
              {graceError && <p className="text-xs text-status-danger-500 mt-1">{graceError}</p>}
            </div>
          </>
        )}
        {section === 'workspace' && isHostRuntime && (
          <div>
            <label
              data-setting-target="host-workspace-directory"
              htmlFor="squad-host-workspace-path"
              className="block text-sm font-medium text-primary mb-1"
            >
              Host workspace directory
            </label>
            {/* The server resolves the directory actually in use, so an empty
                field previews the real default instead of a hand-written guess,
                and a set one is shown alongside what is live today. */}
            <input
              id="squad-host-workspace-path"
              type="text"
              placeholder={sandboxStatus?.workspacePath ?? 'Default: ~/.tau/workspaces/squads/<id>'}
              value={hostWorkspacePathValue ?? ''}
              onInput={(e) =>
                setHostWorkspacePathValue(e.currentTarget.value.trim() === '' ? null : e.currentTarget.value)
              }
              aria-invalid={hostError !== null}
              aria-describedby="squad-host-workspace-path-help"
              className={clsx(
                'ficus-field',
                'w-full px-3 py-2 rounded-lg border bg-surface text-primary text-sm font-mono',
                'placeholder:text-placeholder',
                ' focus:ring-2 focus:ring-accent/50 focus:border-accent',
                hostError
                  ? 'border-status-danger-500 dark:border-status-danger-400'
                  : hostWorkspacePathValue !== hostWorkspacePath
                    ? 'border-status-review-500 dark:border-status-review-400'
                    : 'border-th-border'
              )}
            />
            {/* What is LIVE, from the server. Both halves read the SAVED prop,
                never the edit value: typing must not rewrite the description of
                the directory agents are working in right now. */}
            {hostWorkspacePath && sandboxStatus?.workspacePath && (
              <p className="text-xs text-muted mt-1 font-mono">
                {`Active: ${sandboxStatus.workspacePath}${
                  sandboxStatus.workspacePath === hostWorkspacePath ? '' : ' (applies at next sandbox start)'
                }`}
              </p>
            )}
            <p id="squad-host-workspace-path-help" className="text-xs text-muted mt-1">
              Absolute directory on the Ficus host this squad works in. Takes effect on the squad&apos;s next sandbox
              start. Ficus never deletes this directory.
            </p>
            {hostError && <p className="text-xs text-status-danger-500 mt-1">{hostError}</p>}
          </div>
        )}

        {section === 'general' && (
          <>
            {/* Global Collaboration */}
            <label className="rounded-lg hover:bg-surface-hover flex items-start gap-3 p-3">
              <input
                type="checkbox"
                checked={globalCollaborationEnabledValue}
                onChange={(e) => setGlobalCollaborationEnabledValue(e.target.checked)}
                className="mt-1"
              />
              <span>
                <span className="block text-sm font-medium text-primary">Global collaboration</span>
                <span className="block text-xs text-muted">
                  Allow every other squad manager to discover and message this squad as a collaborator.
                </span>
              </span>
            </label>
          </>
        )}
      </div>

      <div className="flex items-center justify-between mt-4">
        <span className="text-xs text-muted">{dirty ? 'Unsaved changes' : saved ? '✓ Saved' : 'Ctrl+S to save'}</span>
        <button
          onClick={handleSave}
          disabled={!dirty || !isValid || mutation.isPending || !canUpdateSquad}
          className={clsx(
            'ficus-button ficus-button-primary',
            'px-4 py-1.5 text-sm rounded-md font-medium transition-colors',
            !(dirty && isValid && canUpdateSquad) && 'opacity-50 cursor-not-allowed'
          )}
        >
          {mutation.isPending ? 'Saving...' : 'Save'}
        </button>
      </div>

      {mutation.isError && (
        <p className="text-xs text-status-danger-500 mt-2">Failed to save: {String(mutation.error)}</p>
      )}
    </div>
  )
}
