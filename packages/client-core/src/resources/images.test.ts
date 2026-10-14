import { describe, expect, test } from 'bun:test'
import { imagesResource, type ImageContent } from './images'
import type { RequestOptions, Transport } from '../transport'

function mockTransport() {
  const calls: Array<{ path: string; options?: RequestOptions }> = []
  const t: Transport = {
    request: async <T>(path: string, options?: RequestOptions) => {
      calls.push({ path, options })
      return { imageIds: ['image-id'] } as T
    },
    openStream: async () => new ReadableStream<Uint8Array>().getReader(),
    wsUrl: (path) => path,
    url: (path) => path,
  }
  return { t, calls }
}

const images: ImageContent[] = [{ type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' }]

describe('imagesResource.uploadImagesSimple', () => {
  test('serializes a real agent upload target', async () => {
    const { t, calls } = mockTransport()
    await imagesResource(t).uploadImagesSimple(images, { agentId: 'agent-id' })
    expect(calls[0]).toEqual({
      path: '/images',
      options: { method: 'POST', body: { images, agentId: 'agent-id' } },
    })
  })

  test('serializes a squad staging target without an agent ID', async () => {
    const { t, calls } = mockTransport()
    await imagesResource(t).uploadImagesSimple(images, { squadId: 'squad-id' })
    expect(calls[0]).toEqual({
      path: '/images',
      options: { method: 'POST', body: { images, squadId: 'squad-id' } },
    })
  })

  test('retains intentional untargeted uploads', async () => {
    const { t, calls } = mockTransport()
    await imagesResource(t).uploadImagesSimple(images)
    expect(calls[0]?.options?.body).toEqual({ images })
  })
})

describe('imagesResource.deleteStagedImage', () => {
  test('deletes the staged image by ID', async () => {
    const { t, calls } = mockTransport()
    await imagesResource(t).deleteStagedImage('image/id')
    expect(calls).toEqual([{ path: '/images/image%2Fid', options: { method: 'DELETE' } }])
  })
})
