// Hybrid shim: signing + simple upload come from @ficus/client-core; the XHR upload-with-progress
// (uploadImages) stays here because per-image progress needs XMLHttpRequest, not fetch.
import { apiUrl } from './client'
import { client } from './clientInstance'
import type { ImageContent, ImageUploadTarget, UploadProgress } from '@ficus/client-core'
import { CSRF_HEADER } from '@ficus/shared/http-headers'

export type { ImageContent, UploadProgress } from '@ficus/client-core'

type ImageUploadScope = ImageUploadTarget | { agentId?: never; squadId?: never }
export type ImageUploadOptions = ImageUploadScope & {
  onProgress?: (progress: UploadProgress) => void
}

export const signImageUrls = client.images.signImageUrls
export const uploadImagesSimple = client.images.uploadImagesSimple

/**
 * Upload images with progress tracking. Uses XMLHttpRequest for upload progress events.
 */
export async function uploadImages(images: ImageContent[], options?: ImageUploadOptions): Promise<string[]> {
  const imageIds: string[] = []

  for (let i = 0; i < images.length; i++) {
    const imageId = await uploadSingleImage(images[i], {
      ...(options?.agentId ? { agentId: options.agentId } : options?.squadId ? { squadId: options.squadId } : {}),
      onProgress: (loaded, total) => {
        options?.onProgress?.({
          imageIndex: i,
          loaded,
          total,
          percent: Math.round((loaded / total) * 100),
        })
      },
    })
    imageIds.push(imageId)
  }

  return imageIds
}

function uploadSingleImage(
  image: ImageContent,
  options?: ImageUploadScope & {
    onProgress?: (loaded: number, total: number) => void
  }
): Promise<string> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()

    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable) {
        options?.onProgress?.(e.loaded, e.total)
      }
    })

    xhr.addEventListener('load', () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        const response = JSON.parse(xhr.responseText)
        resolve(response.imageIds[0])
      } else {
        try {
          const error = JSON.parse(xhr.responseText)
          reject(new Error(error.error || 'Upload failed'))
        } catch {
          reject(new Error('Upload failed'))
        }
      }
    })

    xhr.addEventListener('error', () => {
      reject(new Error('Network error during upload'))
    })

    xhr.open('POST', apiUrl('/images'))
    xhr.withCredentials = true // send the HttpOnly session cookie cross-origin
    xhr.setRequestHeader('Content-Type', 'application/json')
    xhr.setRequestHeader(CSRF_HEADER, '1')

    xhr.send(
      JSON.stringify({
        images: [image],
        ...(options?.agentId ? { agentId: options.agentId } : options?.squadId ? { squadId: options.squadId } : {}),
      })
    )
  })
}
