import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { uploadAgentFile } from './agentFiles'
import { CSRF_HEADER } from '@ficus/shared/http-headers'

const originalFile = globalThis.File
const originalFormData = globalThis.FormData

class IsolatedFile extends Blob {
  readonly name: string
  constructor(parts: BlobPart[], name: string, options?: FilePropertyBag) {
    super(parts, options)
    this.name = name
  }
}

class IsolatedFormData {
  private readonly values = new Map<string, unknown[]>()
  append(name: string, value: unknown) {
    this.values.set(name, [...(this.values.get(name) ?? []), value])
  }
  get(name: string) {
    return this.values.get(name)?.[0] ?? null
  }
}

class FakeXhr {
  static instances: FakeXhr[] = []
  method = ''
  url = ''
  withCredentials = false
  headers = new Map<string, string>()
  upload: { onprogress?: (event: ProgressEvent) => void } = {}
  onerror?: () => void
  onabort?: () => void
  onload?: () => void
  status = 0
  responseText = ''
  body?: FormData
  aborted = false
  constructor() {
    FakeXhr.instances.push(this)
  }
  open(method: string, url: string) {
    this.method = method
    this.url = url
  }
  setRequestHeader(key: string, value: string) {
    this.headers.set(key, value)
  }
  send(body: FormData) {
    this.body = body
  }
  abort() {
    this.aborted = true
    this.onabort?.()
  }
}

beforeEach(() => {
  FakeXhr.instances = []
  Object.assign(globalThis, { XMLHttpRequest: FakeXhr, File: IsolatedFile, FormData: IsolatedFormData })
})

afterEach(() => {
  Object.assign(globalThis, { File: originalFile, FormData: originalFormData })
})

describe('uploadAgentFile', () => {
  test('uses authenticated multipart fields and reports progress', async () => {
    const onProgress = mock(() => {})
    const promise = uploadAgentFile('agent', 'attachment', new File(['hello'], 'report.pdf'), { onProgress })
    const xhr = FakeXhr.instances[0]
    expect(xhr.method).toBe('POST')
    expect(xhr.url.endsWith('/api/agents/agent/files')).toBe(true)
    expect(xhr.withCredentials).toBe(true)
    expect(xhr.headers.get(CSRF_HEADER)).toBe('1')
    expect(xhr.body?.get('attachmentId')).toBe('attachment')
    const uploaded = xhr.body?.get('file') as IsolatedFile
    expect(uploaded.name).toBe('report.pdf')
    expect(uploaded.type).toBe('')
    expect(await uploaded.text()).toBe('hello')
    xhr.upload.onprogress?.({ lengthComputable: true, loaded: 2, total: 4 } as ProgressEvent)
    expect(onProgress).toHaveBeenCalledWith(0.5)
    xhr.status = 200
    xhr.responseText = JSON.stringify({ id: 'attachment', path: '/private/file' })
    xhr.onload?.()
    expect((await promise).id).toBe('attachment')
  })

  test('aborts with the caller signal and parses server errors', async () => {
    const controller = new AbortController()
    const aborted = uploadAgentFile('agent', 'attachment', new File(['x'], 'x.txt'), { signal: controller.signal })
    controller.abort()
    await expect(aborted).rejects.toMatchObject({ name: 'AbortError' })
    expect(FakeXhr.instances[0].aborted).toBe(true)

    const failed = uploadAgentFile('agent', 'other', new File(['x'], 'x.txt'))
    const xhr = FakeXhr.instances[1]
    xhr.status = 413
    xhr.responseText = JSON.stringify({ error: 'ATTACHMENT_TOO_LARGE' })
    xhr.onload?.()
    await expect(failed).rejects.toThrow('ATTACHMENT_TOO_LARGE')
  })

  // A 2xx whose body is not the expected JSON used to resolve `{}`, and the
  // composer then adopted `'@' + undefined` into the user's message.
  test('rejects a 2xx whose body carries no path', async () => {
    const failed = uploadAgentFile('agent', 'attachment', new File(['x'], 'x.txt'))
    const xhr = FakeXhr.instances[0]
    xhr.status = 200
    xhr.responseText = '<html>hello</html>'
    xhr.onload?.()
    await expect(failed).rejects.toThrow('Upload failed (malformed response)')

    const empty = uploadAgentFile('agent', 'attachment', new File(['x'], 'x.txt'))
    const emptyXhr = FakeXhr.instances[1]
    emptyXhr.status = 200
    emptyXhr.responseText = JSON.stringify({ id: 'attachment', path: '' })
    emptyXhr.onload?.()
    await expect(empty).rejects.toThrow('Upload failed (malformed response)')
  })

  // A restarting server or a proxy answers with no JSON body at all; "Upload
  // failed" alone left the composer with nothing to show, so name the status.
  test('names the status when the failure carries no server message', async () => {
    const failed = uploadAgentFile('agent', 'attachment', new File(['x'], 'x.txt'))
    const xhr = FakeXhr.instances[0]
    xhr.status = 502
    xhr.responseText = '<html>Bad Gateway</html>'
    xhr.onload?.()
    await expect(failed).rejects.toThrow('Upload failed (HTTP 502)')
  })

  test('reports a lost connection distinctly from a server refusal', async () => {
    const failed = uploadAgentFile('agent', 'attachment', new File(['x'], 'x.txt'))
    FakeXhr.instances[0].onerror?.()
    await expect(failed).rejects.toThrow('Upload failed: the connection to the server was lost')
  })
})
