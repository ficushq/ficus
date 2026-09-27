import { useEffect, useState } from 'react'
import { IMAGE_CACHE_NAME } from '@ficus/shared/browser-keys'

/** Pull the stable image id out of a signed image path like `/api/images/<id>?exp=…&sig=…`. */
function parseImageId(url: string): string | null {
  const match = url.match(/\/images\/([^/?#]+)/)
  return match ? match[1] : null
}

/**
 * Resolve a signed image URL to a stable, locally-cached object URL keyed by the image **id**.
 *
 * Signed image URLs carry a rotating `exp`/`sig` query, so the browser's own cache (keyed by full
 * URL) misses on every rotation. We instead cache the bytes by id in the Cache Storage API, so all
 * future loads — across navigations, reloads, and signature rotation — are instant and need no
 * network. The freshly-signed URL is shown immediately (it's always valid when handed to us), then
 * upgraded in place to the cached blob.
 *
 * Falls back to the raw URL when the Cache API is unavailable (SSR / tests) or the URL isn't a
 * signed image path (e.g. a `data:` preview).
 */
export function useCachedImageSrc(url: string | null | undefined): string | null {
  const [src, setSrc] = useState<string | null>(url ?? null)

  useEffect(() => {
    // Show the (valid) signed URL right away; if it's cacheable-by-id we upgrade to the blob below.
    setSrc(url ?? null)

    if (!url) return
    const id = parseImageId(url)
    if (!id || typeof caches === 'undefined') return

    let cancelled = false
    let objectUrl: string | null = null
    const key = `/__tau-image__/${id}`

    void (async () => {
      try {
        const cache = await caches.open(IMAGE_CACHE_NAME)
        let res = await cache.match(key)
        if (!res) {
          const fetched = await fetch(url)
          if (!fetched.ok) return
          await cache.put(key, fetched.clone())
          res = fetched
        }
        const blob = await res.blob()
        if (cancelled) return
        objectUrl = URL.createObjectURL(blob)
        setSrc(objectUrl)
      } catch {
        // Any failure: keep the raw signed URL already set above.
      }
    })()

    return () => {
      cancelled = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [url])

  return src
}
