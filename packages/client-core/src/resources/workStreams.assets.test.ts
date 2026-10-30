import { expect, test } from 'bun:test'
import type { RequestOptions, Transport } from '../transport'
import { workStreamsResource } from './workStreams'

function transport(calls: Array<{ kind: string; path: string; options?: RequestOptions }>): Transport {
  return {
    request: async <T>(path: string, options?: RequestOptions) => {
      calls.push({ kind: 'request', path, options })
      return { inputs: [], attempts: {} } as T
    },
    openStream: async (path, options) => {
      calls.push({ kind: 'stream', path, options })
      return new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([0x89, 0x50]))
          controller.enqueue(new Uint8Array([0x4e, 0x47]))
          controller.close()
        },
      }).getReader()
    },
    wsUrl: (path) => `ws://test${path}`,
    url: (path) => `http://test${path}`,
  }
}

test('lists a stream’s stored-asset references and downloads one through the binary stream seam', async () => {
  const calls: Array<{ kind: string; path: string; options?: RequestOptions }> = []
  const resource = workStreamsResource(transport(calls))
  expect(await resource.assetAttachments('stream/1')).toEqual({ inputs: [], attempts: {} })
  const bytes = await resource.downloadAssetAttachment('stream/1', 'share-id')
  expect([...bytes]).toEqual([0x89, 0x50, 0x4e, 0x47])
  expect(calls).toEqual([
    { kind: 'request', path: '/workstreams/stream%2F1/asset-attachments', options: undefined },
    {
      kind: 'stream',
      path: '/workstreams/stream%2F1/asset-attachments/share-id',
      options: { method: 'GET', signal: undefined },
    },
  ])
})
