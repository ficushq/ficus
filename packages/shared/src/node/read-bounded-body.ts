/** Transport budget failure, distinct from malformed JSON and domain file quotas. */
export class RequestBodyTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super('Request body too large')
  }
}

/** Read at most maxBytes, counting actual wire bytes even when Content-Length is dishonest. */
export async function readBoundedBody(request: Request, maxBytes: number): Promise<Uint8Array> {
  const reader = request.body?.getReader()
  const abort = () => {
    void reader?.cancel().catch(() => {})
  }
  request.signal.addEventListener('abort', abort, { once: true })
  let complete = false
  try {
    const length = request.headers.get('content-length')
    if (length && /^\d+$/.test(length) && Number(length) > maxBytes) throw new RequestBodyTooLargeError(maxBytes)
    if (!reader) return new Uint8Array()
    const chunks: Uint8Array[] = []
    let bytes = 0
    while (true) {
      request.signal.throwIfAborted()
      const { done, value } = await reader.read()
      request.signal.throwIfAborted()
      if (done) break
      bytes += value.byteLength
      if (bytes > maxBytes) throw new RequestBodyTooLargeError(maxBytes)
      chunks.push(value)
    }
    const result = new Uint8Array(bytes)
    let offset = 0
    for (const chunk of chunks) {
      result.set(chunk, offset)
      offset += chunk.byteLength
    }
    complete = true
    return result
  } finally {
    request.signal.removeEventListener('abort', abort)
    try {
      if (!complete) await reader?.cancel().catch(() => {})
    } finally {
      reader?.releaseLock()
    }
  }
}
