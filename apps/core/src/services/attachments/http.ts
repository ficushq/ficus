/** Buffer a multipart body, refusing it as soon as it exceeds `maxBytes` (the declared length is not trusted). */
export async function readBoundedMultipart(request: Request, maxBytes: number): Promise<FormData> {
  // Snapshot before consuming: Bun's lazy FormData serialization must materialize
  // the matching boundary in Headers before its body stream is drained.
  const contentType = request.headers.get('content-type') ?? ''
  if (!request.body) throw new Error('Missing multipart body')
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel()
        throw new Error('ATTACHMENT_TOO_LARGE')
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new Response(bytes, { headers: { 'content-type': contentType } }).formData()
}

/** An attachment `Content-Disposition` with an ASCII-safe fallback name and the exact UTF-8 name. */
export function downloadDisposition(filename: string): string {
  const fallback = filename.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '') || 'attachment'
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`
}
