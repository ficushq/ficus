import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import clsx from 'clsx'
import { queries } from '../../queryOptions'
import { queryKeys } from '../../queryKeys'
import { uploadSquadAvatar, removeSquadAvatar, fileToAvatarImage } from '../../api/squads'
import { usePermissions } from '../../hooks/usePermissions'
import { SquadAvatar } from './SquadAvatar'

const ACCEPT = 'image/png,image/jpeg,image/gif,image/webp'

/** Squad avatar upload/change/remove for the General settings tab (circular preview = crop preview). */
export function SquadAvatarSettings({ squadId, name }: { squadId: string; name: string }) {
  const queryClient = useQueryClient()
  const fileRef = useRef<HTMLInputElement>(null)
  const { can, isLoading: permsLoading } = usePermissions(squadId)
  const canUpdate = !permsLoading && can('squads:update')

  const { data: squad } = useQuery(queries.squads.detail(squadId))
  const avatarUrl = squad?.avatarUrl ?? null

  // Local object-URL preview while uploading, so the crop is visible immediately in the circle.
  const [preview, setPreview] = useState<string | null>(null)
  useEffect(
    () => () => {
      if (preview) URL.revokeObjectURL(preview)
    },
    [preview]
  )

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: queryKeys.squads.detail(squadId) })
    queryClient.invalidateQueries({ queryKey: queryKeys.squads.all })
  }
  const clearPreview = () => setPreview((url) => (url ? (URL.revokeObjectURL(url), null) : null))

  const uploadMutation = useMutation({
    mutationFn: async (file: File) => uploadSquadAvatar(squadId, await fileToAvatarImage(file)),
    onSuccess: invalidate,
    onSettled: clearPreview,
  })
  const removeMutation = useMutation({ mutationFn: () => removeSquadAvatar(squadId), onSuccess: invalidate })

  const onPick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    clearPreview()
    setPreview(URL.createObjectURL(file))
    uploadMutation.mutate(file)
  }

  const busy = uploadMutation.isPending || removeMutation.isPending

  return (
    <div className="mb-6">
      <div className="flex items-center gap-4">
        <SquadAvatar name={squad?.name ?? name} avatarUrl={preview ?? avatarUrl} size={56} />
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={() => fileRef.current?.click()}
            disabled={!canUpdate || busy}
            className={clsx(
              'ficus-button ficus-button-primary',
              'px-3 py-1.5 text-sm rounded-md font-medium',
              !(canUpdate && !busy) && 'opacity-50 cursor-not-allowed'
            )}
          >
            {uploadMutation.isPending ? 'Uploading…' : avatarUrl ? 'Change' : 'Upload image'}
          </button>
          {avatarUrl && (
            <button
              onClick={() => removeMutation.mutate()}
              disabled={!canUpdate || busy}
              className="ficus-button ficus-button-danger px-3 py-1.5 text-sm rounded-md font-medium disabled:opacity-50"
            >
              Remove
            </button>
          )}
        </div>
      </div>
      <p className="text-xs text-muted mt-2">
        Shown as a circle — non-square images are cropped to fill. PNG, JPEG, GIF, or WebP.
      </p>
      {uploadMutation.isError && <p className="text-xs text-status-danger-500 mt-1">{String(uploadMutation.error)}</p>}
      <input ref={fileRef} type="file" accept={ACCEPT} className="hidden" onChange={onPick} />
    </div>
  )
}
