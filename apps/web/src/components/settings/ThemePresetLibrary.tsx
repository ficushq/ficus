import { useRef, useState } from 'react'
import clsx from 'clsx'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CUSTOM_THEME_FORMAT, type ThemePreset } from '@ficus/shared'
import { isHttpResponseError } from '@ficus/client-core'
import type { useTheme } from '../../providers/ThemeProvider'
import { selfServiceQueryEnabled, useOptionalAuth } from '../../providers/AuthProvider'
import { usePermissions } from '../../hooks/usePermissions'
import { client } from '../../api/clientInstance'
import { queries } from '../../queryOptions'
import { themePresetQueryKeys } from '../../queryKeys'
import { exportCustomTheme, importCustomTheme, presetAppearance } from '../../theme/custom'
import { ThemeSwatch } from '../ThemeSwatch'
import { OverflowMenu } from '../OverflowMenu'
import { CustomThemeEditor } from './CustomThemeEditor'

type EditorTarget = { preset: ThemePreset | null; baseId: string; focusAssistant?: boolean }

function errorMessage(error: unknown, fallback: string): string {
  if (isHttpResponseError(error, 409)) return 'This theme changed elsewhere — reload it before trying again.'
  return error instanceof Error ? error.message : fallback
}

/** One preset's swatch, painted from its own compiled document (not a hover
 * preview) — the same DOM-only paint path as everything else in the theme system. */
function PresetSwatch({ preset, currentAppearance }: { preset: ThemePreset; currentAppearance: 'light' | 'dark' }) {
  return (
    <ThemeSwatch
      spec={{
        kind: 'preset',
        document: preset.document,
        appearance: presetAppearance(preset.document, currentAppearance),
      }}
      className="h-8 w-8 shrink-0"
    />
  )
}

export function ThemePresetLibrary({ value }: { value: ReturnType<typeof useTheme> }) {
  // Gated identically to AppNav's ThemeQuickPicker presets query (see
  // selfServiceQueryEnabled) — an auth-disabled instance must see its
  // presets here too, not just in the quick picker.
  const auth = useOptionalAuth()
  const enabled = selfServiceQueryEnabled(auth)
  const { data: presets = [] } = useQuery({ ...queries.themePresets.list('mine'), enabled })
  const { data: shared = [] } = useQuery({ ...queries.themePresets.list('shared'), enabled })
  const { identity, can } = usePermissions()
  const myUserId = identity?.type === 'user' ? identity.userId : undefined
  const cache = useQueryClient()
  const [editing, setEditing] = useState<EditorTarget | null>(null)
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null)
  const [notice, setNotice] = useState('')
  const importInput = useRef<HTMLInputElement>(null)

  const invalidate = () => void cache.invalidateQueries({ queryKey: themePresetQueryKeys.all })

  // Phase 2 live link: the active selection references a preset owned by
  // someone else (`presetOwnerId` is retained even after `refreshLinkedPreset`
  // clears `presetId` on a 404 — see ThemeSyncStore.refreshLinkedPreset and
  // ThemePreference.presetOwnerId's doc comments). Gated on `myUserId` being
  // known so a not-yet-loaded identity never flashes this for the caller's
  // OWN silently-detached preset (Phase 1 behavior, unchanged there).
  const foreignDetached =
    !value.presetId && !!value.presetOwnerId && !!myUserId && value.presetOwnerId !== myUserId && !!value.customTheme

  const duplicate = useMutation({
    mutationFn: (preset: ThemePreset) => client.themePresets.duplicate(preset.id),
    onSuccess: invalidate,
    onError: (error) => setNotice(errorMessage(error, 'Duplicate failed.')),
  })
  const share = useMutation({
    mutationFn: (preset: ThemePreset) =>
      client.themePresets.setVisibility(
        preset.id,
        preset.revision,
        preset.visibility === 'instance' ? 'private' : 'instance'
      ),
    onSuccess: invalidate,
    onError: (error) => setNotice(errorMessage(error, 'Updating sharing failed.')),
  })
  const removeShare = useMutation({
    mutationFn: (preset: ThemePreset) => client.themePresets.removeShare(preset.id),
    onSuccess: invalidate,
    onError: (error) => setNotice(errorMessage(error, 'Removing from the shared list failed.')),
  })
  const keepCopy = useMutation({
    mutationFn: () => client.themePresets.create(value.customTheme),
    onSuccess: (created) => {
      invalidate()
      value.applyPreset(created)
      setNotice('Saved a copy to your library.')
    },
    onError: (error) => setNotice(errorMessage(error, 'Saving a copy failed.')),
  })
  const rename = useMutation({
    mutationFn: ({ preset, name }: { preset: ThemePreset; name: string }) =>
      client.themePresets.update(preset.id, preset.revision, { ...preset.document, name }),
    onSuccess: (updated) => {
      invalidate()
      if (value.presetId === updated.id) value.applyPreset(updated)
      setRenaming(null)
    },
    onError: (error) => setNotice(errorMessage(error, 'Rename failed.')),
  })
  const remove = useMutation({
    // Deleting a preset that is someone's active selection does not break
    // them: the applied document snapshot stays in ThemeProvider state, and
    // presetId simply dangles — the UI just treats it as detached.
    mutationFn: (preset: ThemePreset) => client.themePresets.delete(preset.id, preset.revision),
    onSuccess: invalidate,
    onError: (error) => setNotice(errorMessage(error, 'Delete failed.')),
  })

  const download = (preset: ThemePreset) => {
    try {
      const url = URL.createObjectURL(new Blob([exportCustomTheme(preset.document)], { type: 'application/json' }))
      const link = document.createElement('a')
      link.href = url
      link.download = `${preset.document.name || CUSTOM_THEME_FORMAT}.json`
      link.click()
      setTimeout(() => URL.revokeObjectURL(url), 0)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Export failed.')
    }
  }

  /** A preset row's secondary actions, as plain rows in its overflow menu like the other OverflowMenu callers. */
  const presetSecondaryActions = (preset: ThemePreset) => {
    const buttonClass = 'ficus-button ficus-button-ghost'
    return (
      <>
        <button className={buttonClass} onClick={() => setRenaming({ id: preset.id, name: preset.document.name })}>
          Rename
        </button>
        <button className={buttonClass} disabled={share.isPending} onClick={() => share.mutate(preset)}>
          {preset.visibility === 'instance' ? 'Unshare' : 'Share'}
        </button>
        <button className={buttonClass} disabled={duplicate.isPending} onClick={() => duplicate.mutate(preset)}>
          Duplicate
        </button>
        <button className={buttonClass} onClick={() => download(preset)}>
          Export
        </button>
        <button
          className={buttonClass}
          disabled={remove.isPending}
          onClick={() => {
            if (window.confirm(`Delete "${preset.document.name}"? This cannot be undone.`)) remove.mutate(preset)
          }}
        >
          Delete
        </button>
      </>
    )
  }

  return (
    <>
      {foreignDetached && (
        <div className="mt-4 rounded-lg border border-th-border p-3 text-sm">
          <p>This shared theme is no longer available — keep a copy to keep using it.</p>
          <button
            className="ficus-button mt-2 min-h-[36px] px-2 py-1 ficus-button-secondary"
            disabled={keepCopy.isPending}
            onClick={() => keepCopy.mutate()}
          >
            Keep a copy
          </button>
        </div>
      )}
      <div className="mt-4 flex flex-col gap-3 text-sm">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h4 className="font-medium text-primary">My themes</h4>
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="ficus-button min-h-[36px] px-3 py-1.5 ficus-button-secondary"
              // Starts from the theme in use, with the assistant panel focused when it's shown (gated on
              // `chat:send` inside CustomThemeEditor); the editor's Based on changes the base.
              onClick={() => setEditing({ preset: null, baseId: value.themeId, focusAssistant: true })}
            >
              New theme
            </button>
            {/* The native file input stays hidden and only opens the file picker. */}
            <button
              type="button"
              className="ficus-button min-h-[36px] px-3 py-1.5 ficus-button-secondary"
              onClick={() => importInput.current?.click()}
            >
              Import JSON…
            </button>
          </div>
        </div>
        {presets.length === 0 && (
          <p className="rounded-lg border border-dashed border-th-border px-4 py-5 text-center text-secondary">
            No saved themes yet. <span className="text-primary">New theme</span> starts from the theme you&rsquo;re
            using now; <span className="text-primary">Import JSON…</span> adds one someone shared with you.
          </p>
        )}
        <ul className="flex flex-col gap-2">
          {presets.map((preset) => {
            const active = value.presetId === preset.id
            return (
              <li
                key={preset.id}
                className={clsx(
                  'flex flex-wrap items-center gap-2 rounded-lg border p-2',
                  active ? 'border-accent' : 'border-th-border'
                )}
              >
                <PresetSwatch preset={preset} currentAppearance={value.theme} />
                {renaming?.id === preset.id ? (
                  <form
                    className="flex items-center gap-1"
                    onSubmit={(event) => {
                      event.preventDefault()
                      rename.mutate({ preset, name: renaming.name })
                    }}
                  >
                    <input
                      className="ficus-field px-2 py-1"
                      autoFocus
                      maxLength={40}
                      value={renaming.name}
                      onChange={(event) => setRenaming({ id: preset.id, name: event.target.value })}
                    />
                    <button className="ficus-button min-h-[36px] px-2 py-1 ficus-button-primary" type="submit">
                      Save
                    </button>
                    <button
                      className="ficus-button min-h-[36px] px-2 py-1 ficus-button-secondary"
                      type="button"
                      onClick={() => setRenaming(null)}
                    >
                      Cancel
                    </button>
                  </form>
                ) : (
                  <span className="flex flex-1 flex-wrap items-center gap-2 font-medium">
                    {preset.document.name}
                    {active && (
                      <span className="rounded-full bg-selection px-2 py-0.5 text-xs font-normal text-accent-light">
                        In use
                      </span>
                    )}
                    {preset.visibility === 'instance' && (
                      <span className="text-secondary text-xs font-normal">Shared</span>
                    )}
                  </span>
                )}
                <div className="flex flex-wrap items-center gap-1">
                  <button
                    className="ficus-button min-h-[36px] px-2 py-1 ficus-button-secondary"
                    disabled={active}
                    onClick={() => value.applyPreset(preset)}
                  >
                    Use
                  </button>
                  <button
                    className="ficus-button min-h-[36px] px-2 py-1 ficus-button-secondary"
                    onClick={() => setEditing({ preset, baseId: preset.document.base })}
                  >
                    Edit
                  </button>
                  {/* Use and Edit stay visible; the rest live in the overflow menu at every width. */}
                  <div>
                    <OverflowMenu
                      label={`More actions for ${preset.document.name}`}
                      itemsMarker="data-theme-preset-actions"
                    >
                      {presetSecondaryActions(preset)}
                    </OverflowMenu>
                  </div>
                </div>
              </li>
            )
          })}
        </ul>
        <input
          ref={importInput}
          aria-label="Import theme preset JSON"
          type="file"
          accept=".json,application/json"
          className="hidden"
          onChange={async (event) => {
            const file = event.target.files?.[0]
            event.target.value = ''
            if (!file) return
            const result = await importCustomTheme(file)
            if (!result.ok) {
              setNotice(result.error)
              return
            }
            try {
              await client.themePresets.create(result.document)
              invalidate()
              setNotice('Imported into your theme library.')
            } catch (error) {
              setNotice(errorMessage(error, 'Import failed.'))
            }
          }}
        />
        {notice && <p role="status">{notice}</p>}
        {editing && (
          <CustomThemeEditor
            value={value}
            preset={editing.preset}
            baseId={editing.baseId}
            onClose={() => setEditing(null)}
            focusAssistant={editing.focusAssistant}
          />
        )}
      </div>
      {shared.length > 0 && (
        <div className="mt-4 flex flex-col gap-3 text-sm">
          <h4 className="font-medium text-primary">Shared themes</h4>
          <ul className="flex flex-col gap-2">
            {shared.map((preset) => {
              const active = value.presetId === preset.id
              return (
                <li
                  key={preset.id}
                  className={clsx(
                    'flex flex-wrap items-center gap-2 rounded-lg border p-2',
                    active ? 'border-accent' : 'border-th-border'
                  )}
                >
                  <PresetSwatch preset={preset} currentAppearance={value.theme} />
                  <span className="flex-1">
                    <span className="font-medium">{preset.document.name}</span>{' '}
                    <span className="text-secondary text-xs">by {preset.owner.displayName}</span>{' '}
                    {active && <span className="text-secondary">(active)</span>}
                  </span>
                  <div className="flex flex-wrap gap-1">
                    <button
                      className="ficus-button min-h-[36px] px-2 py-1 ficus-button-secondary"
                      disabled={active}
                      onClick={() => value.applyPreset(preset)}
                    >
                      Use
                    </button>
                    <button
                      className="ficus-button min-h-[36px] px-2 py-1 ficus-button-secondary"
                      disabled={duplicate.isPending}
                      onClick={() => duplicate.mutate(preset)}
                    >
                      Duplicate
                    </button>
                    {can('theme-presets:moderate') && (
                      <button
                        className="ficus-button min-h-[36px] px-2 py-1 ficus-button-secondary"
                        disabled={removeShare.isPending}
                        onClick={() => {
                          if (
                            window.confirm(
                              `Remove "${preset.document.name}" from the shared list? ${preset.owner.displayName} keeps it in their own library.`
                            )
                          )
                            removeShare.mutate(preset)
                        }}
                      >
                        Remove from shared
                      </button>
                    )}
                  </div>
                </li>
              )
            })}
          </ul>
        </div>
      )}
    </>
  )
}
