import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { uploadImages } from './images'
import { CSRF_HEADER } from '@ficus/shared/http-headers'

type Listener = (event: ProgressEvent) => void

class FakeXhr {
  static instances: FakeXhr[] = []
  method = ''
  url = ''
  status = 0
  responseText = ''
  withCredentials = false
  headers = new Map<string, string>()
  body = ''
  private listeners = new Map<string, Listener>()
  upload = {
    addEventListener: (name: string, listener: Listener) => this.listeners.set(`upload:${name}`, listener),
  }

  constructor() {
    FakeXhr.instances.push(this)
  }

  addEventListener(name: string, listener: Listener) {
    this.listeners.set(name, listener)
  }
  open(method: string, url: string) {
    this.method = method
    this.url = url
  }
  setRequestHeader(name: string, value: string) {
    this.headers.set(name, value)
  }
  send(body: string) {
    this.body = body
  }
  complete(imageId: string) {
    this.status = 200
    this.responseText = JSON.stringify({ imageIds: [imageId] })
    this.listeners.get('load')?.({} as ProgressEvent)
  }
}

const originalXhr = globalThis.XMLHttpRequest

beforeEach(() => {
  FakeXhr.instances = []
  globalThis.XMLHttpRequest = FakeXhr as unknown as typeof XMLHttpRequest
})

afterEach(() => {
  globalThis.XMLHttpRequest = originalXhr
})

describe('uploadImages', () => {
  test.each([
    { options: { agentId: 'agent-1' }, expectedTarget: { agentId: 'agent-1' } },
    { options: { squadId: 'squad-1' }, expectedTarget: { squadId: 'squad-1' } },
    { options: {}, expectedTarget: {} },
  ])('sends only the selected conversation target: $expectedTarget', async ({ options, expectedTarget }) => {
    const promise = uploadImages([{ type: 'image', data: 'cG5n', mimeType: 'image/png' }], options)
    const xhr = FakeXhr.instances[0]!
    const body = JSON.parse(xhr.body) as Record<string, unknown>

    expect(xhr.method).toBe('POST')
    expect(xhr.withCredentials).toBe(true)
    expect(xhr.headers.get(CSRF_HEADER)).toBe('1')
    expect(body).toMatchObject({ images: [{ type: 'image', data: 'cG5n', mimeType: 'image/png' }], ...expectedTarget })
    expect('agentId' in body).toBe('agentId' in expectedTarget)
    expect('squadId' in body).toBe('squadId' in expectedTarget)

    xhr.complete('image-1')
    expect(await promise).toEqual(['image-1'])
  })
})
