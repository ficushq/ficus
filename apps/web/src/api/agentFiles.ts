import { apiFetch, apiUrl } from './client'
import { CSRF_HEADER } from '@ficus/shared/http-headers'

export interface AgentFileUpload {
  id: string
  path: string
  displayName: string
  contentType: string
  byteSize: number
  sha256: string
}

export function uploadAgentFile(
  agentId: string,
  attachmentId: string,
  file: File,
  options: { signal?: AbortSignal; onProgress?: (fraction: number) => void } = {}
): Promise<AgentFileUpload> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', apiUrl(`/agents/${agentId}/files`))
    xhr.withCredentials = true
    xhr.setRequestHeader(CSRF_HEADER, '1')
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) options.onProgress?.(event.loaded / event.total)
    }
    // Distinguishable from a server refusal: this is the shape a mid-request
    // API restart takes, and the composer now shows the reason verbatim.
    xhr.onerror = () => reject(new Error('Upload failed: the connection to the server was lost'))
    xhr.onabort = () => reject(new DOMException('Upload aborted', 'AbortError'))
    xhr.onload = () => {
      let body: { error?: string } & Partial<AgentFileUpload> = {}
      try {
        body = JSON.parse(xhr.responseText)
      } catch {
        // A non-JSON error body falls back to the generic upload message below.
      }
      if (xhr.status < 200 || xhr.status >= 300) {
        return reject(new Error(body.error || `Upload failed (HTTP ${xhr.status})`))
      }
      // A 2xx with an unusable body is a FAILURE, not an upload without a path:
      // resolving it fed `undefined` to the composer, which adopted the literal
      // token `@undefined` into the user's message and unblocked sending.
      if (typeof body.path !== 'string' || !body.path) {
        return reject(new Error('Upload failed (malformed response)'))
      }
      resolve(body as AgentFileUpload)
    }
    const abort = () => xhr.abort()
    options.signal?.addEventListener('abort', abort, { once: true })
    const form = new FormData()
    form.append('attachmentId', attachmentId)
    form.append('file', file)
    xhr.send(form)
  })
}

export async function deleteAgentFile(agentId: string, attachmentId: string): Promise<void> {
  await apiFetch(`/agents/${agentId}/files/${attachmentId}`, { method: 'DELETE' })
}
