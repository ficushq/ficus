import { expect, test } from 'bun:test'
import { readBoundedMultipart } from './http'

test('native FormData requests retain their boundary without callers first reading headers', async () => {
  const form = new FormData()
  form.set('audio', new File(['fixture audio'], 'audio.wav', { type: 'audio/wav' }))
  // No middleware/header inspection: Bun serializes this FormData lazily.
  const request = new Request('http://localhost/transcribe', { method: 'POST', body: form })
  const decoded = await readBoundedMultipart(request, 64 * 1024)
  const audio = decoded.get('audio')
  expect(audio).toBeInstanceOf(File)
  expect((audio as File).name).toBe('audio.wav')
  expect(await (audio as File).text()).toBe('fixture audio')
})

test('actual multipart bytes override a short declared length and cancel overflow', async () => {
  let pulls = 0
  let cancelled = false
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        pulls++
        controller.enqueue(new Uint8Array(2))
      },
      cancel() {
        cancelled = true
      },
    },
    { highWaterMark: 0 }
  )
  const request = new Request('http://localhost/upload', {
    method: 'POST',
    headers: { 'content-type': 'multipart/form-data; boundary=test', 'content-length': '1' },
    body,
  })
  await expect(readBoundedMultipart(request, 3)).rejects.toThrow('ATTACHMENT_TOO_LARGE')
  expect(pulls).toBe(2)
  expect(cancelled).toBe(true)
  expect(request.body!.locked).toBe(false)
})
