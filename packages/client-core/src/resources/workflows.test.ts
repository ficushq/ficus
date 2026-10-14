import { expect, test } from 'bun:test'
import type { RequestOptions, Transport } from '../transport'
import { workflowsResource } from './workflows'

test('downloadAttachment reads the whole attachment body through the stream seam both hosts implement', async () => {
  const calls: Array<{ path: string; options?: RequestOptions }> = []
  const transport: Transport = {
    request: async () => {
      throw Error('not used')
    },
    openStream: async (path, options) => {
      calls.push({ path, options })
      const encoder = new TextEncoder()
      return new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode('# Design\n'))
          controller.enqueue(encoder.encode('The plan.'))
          controller.close()
        },
      }).getReader()
    },
    wsUrl: (path) => `ws://test${path}`,
    url: (path) => `http://test${path}`,
  }
  const bytes = await workflowsResource(transport).downloadAttachment('stream/1', 'file-id')
  expect(new TextDecoder().decode(bytes)).toBe('# Design\nThe plan.')
  expect(calls).toEqual([
    { path: '/workflows/runs/stream%2F1/attachments/file-id', options: { method: 'GET', signal: undefined } },
  ])
})
