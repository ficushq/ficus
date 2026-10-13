import type { Transport } from '../transport'

export interface ImageContent {
  type: 'image'
  data: string
  mimeType: string
}

export type ImageUploadTarget = { agentId: string; squadId?: never } | { squadId: string; agentId?: never }

export interface UploadProgress {
  imageIndex: number
  loaded: number
  total: number
  percent: number
}

export function imagesResource(t: Transport) {
  return {
    /**
     * Resolve signed display URLs for a set of image ids.
     */
    signImageUrls: async (ids: string[]): Promise<Record<string, string>> => {
      if (ids.length === 0) return {}

      const { urls } = await t.request<{ urls: Record<string, string> }>('/images/sign-urls', {
        method: 'POST',
        body: { ids },
      })
      return urls
    },

    /**
     * Upload images (simpler, no progress tracking).
     */
    uploadImagesSimple: async (images: ImageContent[], target?: ImageUploadTarget): Promise<string[]> => {
      const data = await t.request<{ imageIds: string[] }>('/images', {
        method: 'POST',
        body: { images, ...target },
      })
      return data.imageIds
    },

    /**
     * Delete the caller's own staged upload: an image they uploaded with no agent or squad that
     * was never sent. Core refuses anything else, with the same answer as for an unknown image.
     */
    deleteStagedImage: async (id: string): Promise<void> => {
      await t.request(`/images/${encodeURIComponent(id)}`, { method: 'DELETE' })
    },
  }
}
