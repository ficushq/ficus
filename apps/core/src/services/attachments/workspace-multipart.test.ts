import { expect, test } from 'bun:test'
import { access, readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { stageWorkspaceMultipart } from './workspace-multipart'

function multipart(body: string) {
  return new Request('http://localhost/', {
    method: 'POST',
    headers: { 'content-type': 'multipart/form-data; boundary=test' },
    body,
  })
}
test('stages files before late paths with exact identity; owns cleanup', async () => {
  const req = multipart(
    '--test\r\nContent-Disposition: form-data; name="file0"; filename="../original.txt"\r\nContent-Type: text/plain\r\n\r\nhello\r\n--test\r\nContent-Disposition: form-data; name="path_file0"\r\n\r\nnested/hello.txt\r\n--test--\r\n'
  )
  req.formData = async () => {
    throw new Error('buffer forbidden')
  }
  const staged = await stageWorkspaceMultipart(req)
  const file = staged.files[0]!
  try {
    expect(file.filename).toBe('../original.txt')
    expect(file.bytes).toBe(5)
    expect(file.sha256).toBe(createHash('sha256').update('hello').digest('hex'))
    expect(await readFile(file.tempPath, 'utf8')).toBe('hello')
    expect(staged.fields.get('path_file0')).toBe('nested/hello.txt')
  } finally {
    await staged.cleanup()
  }
  await expect(access(file.tempPath)).rejects.toThrow()
})
test('malformed multipart rejects rather than accepting a truncated file', async () => {
  await expect(
    stageWorkspaceMultipart(
      multipart('--test\r\nContent-Disposition: form-data; name="file0"; filename="a"\r\n\r\ntruncated')
    )
  ).rejects.toThrow()
})
test('empty file and repeated fields retain first-field semantics', async () => {
  const form = new FormData()
  form.append('file', new File([], 'empty'))
  form.append('path_file', 'first')
  form.append('path_file', 'second')
  const staged = await stageWorkspaceMultipart(new Request('http://localhost/', { method: 'POST', body: form }))
  try {
    expect(staged.files[0]!.bytes).toBe(0)
    expect(staged.fields.get('path_file')).toBe('first')
  } finally {
    await staged.cleanup()
  }
})
test('source abort and oversized field fail closed', async () => {
  const controller = new AbortController()
  const req = new Request('http://localhost/', {
    method: 'POST',
    headers: { 'content-type': 'multipart/form-data; boundary=test' },
    body: new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode('--test\r\n'))
      },
    }),
    signal: controller.signal,
  })
  const result = stageWorkspaceMultipart(req)
  controller.abort()
  await expect(result).rejects.toThrow()
  const form = new FormData()
  form.append('path_file', 'x'.repeat(1024 ** 2 + 1))
  await expect(
    stageWorkspaceMultipart(new Request('http://localhost/', { method: 'POST', body: form }))
  ).rejects.toThrow()
})
