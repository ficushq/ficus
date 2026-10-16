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

test('run keeps the delivery history by default and asks the server to omit it only when opted out', async () => {
  const paths: string[] = []
  const transport: Transport = {
    request: async <T>(path: string) => {
      paths.push(path)
      return null as T
    },
    openStream: async () => {
      throw Error('not used')
    },
    wsUrl: (path) => `ws://test${path}`,
    url: (path) => `http://test${path}`,
  }
  const workflows = workflowsResource(transport)
  await workflows.run('stream/1')
  await workflows.run('stream/1', { integrationDeliveries: true })
  await workflows.run('stream/1', { integrationDeliveries: false })
  expect(paths).toEqual([
    '/workflows/runs/stream%2F1',
    '/workflows/runs/stream%2F1',
    '/workflows/runs/stream%2F1?integrationDeliveries=0',
  ])
})
