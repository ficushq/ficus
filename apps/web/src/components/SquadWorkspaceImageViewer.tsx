/**
 * Displays an image from a workspace (the squad's shared workspace or an
 * agent's private area). Fetches the download URL with auth and renders it.
 */

import { useEffect, useRef, useState } from 'react'
import { getSquadWorkspaceDownloadUrl } from '../api/workspace'
import { authFetch } from '../api/client'
import { LoadingSurface, SkeletonBlock } from './loading/Skeleton'

export interface WorkspaceImageViewerProps {
  /** API path of the image download (e.g. a workspace or private-area download URL). */
  downloadUrl: string
  alt?: string
  className?: string
}

export function WorkspaceImageViewer({ downloadUrl, alt, className }: WorkspaceImageViewerProps) {
  const [imageUrl, setImageUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const urlRef = useRef<string | null>(null)

  useEffect(() => {
    setLoading(true)
    setError(null)
    authFetch(downloadUrl)
      .then((response) => {
        if (!response.ok) throw new Error('Failed to load image')
        return response.blob()
      })
      .then((blob) => {
        // Downloads may be served as opaque bytes; the <img> only needs the bytes.
        const url = window.URL.createObjectURL(blob)
        urlRef.current = url
        setImageUrl(url)
        setLoading(false)
      })
      .catch((err) => {
        setError(err.message)
        setLoading(false)
      })

    return () => {
      if (urlRef.current) {
        window.URL.revokeObjectURL(urlRef.current)
        urlRef.current = null
      }
    }
  }, [downloadUrl])

  if (loading) {
    return (
      <LoadingSurface label="Loading image" className="flex h-full min-h-48 w-full items-center justify-center">
        <SkeletonBlock className="h-full min-h-48 w-full rounded-lg" />
      </LoadingSurface>
    )
  }

  if (error) {
    return <div className="text-status-danger-500">Failed to load image: {error}</div>
  }

  return (
    <img src={imageUrl || ''} alt={alt || 'Image'} className={className ?? 'max-w-full max-h-full object-contain'} />
  )
}

export interface SquadWorkspaceImageViewerProps {
  squadId: string
  filePath: string
  className?: string
}

export function SquadWorkspaceImageViewer({ squadId, filePath, className }: SquadWorkspaceImageViewerProps) {
  return (
    <WorkspaceImageViewer
      downloadUrl={getSquadWorkspaceDownloadUrl(squadId, filePath)}
      alt={filePath.split('/').pop() || 'Image'}
      className={className}
    />
  )
}
