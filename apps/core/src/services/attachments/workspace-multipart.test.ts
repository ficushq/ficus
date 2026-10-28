import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'bun:test'
import { access, readFile, mkdtemp, readdir, rm } from 'node:fs/promises'
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
  form.append('path_file', 'x'.repeat(4 * 1024 ** 2 + 1))
  await expect(
    stageWorkspaceMultipart(new Request('http://localhost/', { method: 'POST', body: form }))
  ).rejects.toThrow()
})

function twoFiles(extraHeaders: string) {
  return (
    '--test\r\nContent-Disposition: form-data; name="a"; filename="a.txt"\r\n\r\none\r\n--test\r\n' +
    extraHeaders +
    'Content-Disposition: form-data; name="b"; filename="b.txt"\r\n\r\ntwo\r\n--test--\r\n'
  )
}
for (const headers of [
  'X-Padding: ' + 'x'.repeat(82 * 1024) + '\r\n',
  Array.from({ length: 2001 }, (_, i) => `X-${i}: x\r\n`).join(''),
])
  test('preserves both native-reader files beyond old silent header thresholds ' + headers.length, async () => {
    const request = multipart(twoFiles(headers))
    expect([...(await request.clone().formData()).values()].map((v) => (v as unknown as File).name)).toEqual([
      'a.txt',
      'b.txt',
    ])
    const staged = await stageWorkspaceMultipart(request)
    try {
      expect(staged.files.map((f) => f.filename)).toEqual(['a.txt', 'b.txt'])
      expect(await readFile(staged.files[1]!.tempPath, 'utf8')).toBe('two')
    } finally {
      await staged.cleanup()
    }
  })

test('approved extra-field entry boundary includes duplicates', async () => {
  const form = new FormData()
  for (let i = 0; i < 256; i++) form.append('unused', 'x')
  const accepted = await stageWorkspaceMultipart(new Request('http://localhost/', { method: 'POST', body: form }))
  await accepted.cleanup()
  form.append('unused', 'x')
  await expect(
    stageWorkspaceMultipart(new Request('http://localhost/', { method: 'POST', body: form }))
  ).rejects.toThrow('collection')
})
test('approved metadata byte budget is aggregate, not per-field', async () => {
  const form = new FormData()
  for (let i = 0; i < 5; i++) form.append('unused' + i, 'x'.repeat(900 * 1024))
  await expect(
    stageWorkspaceMultipart(new Request('http://localhost/', { method: 'POST', body: form }))
  ).rejects.toThrow('metadata')
})
test('late malformed headers cannot silently discard a file after an earlier valid file', async () => {
  await expect(stageWorkspaceMultipart(multipart(twoFiles('Not-a-header\r\n')))).rejects.toThrow()
})

test('metadata byte limit accepts the exact boundary and rejects one extra byte', async () => {
  const prefix = '--test\r\nContent-Disposition: form-data; name="extra"\r\n\r\n'
  const suffix = '\r\n--test--\r\n'
  // Wire envelope + separately accounted boundary parameter and decoded field name.
  const overhead = Buffer.byteLength(prefix + suffix) + Buffer.byteLength('testextra')
  const body = prefix + 'x'.repeat(4 * 1024 ** 2 - overhead) + suffix
  const accepted = await stageWorkspaceMultipart(multipart(body))
  try {
    expect(accepted.fields.get('extra')?.length).toBe(4 * 1024 ** 2 - overhead)
  } finally {
    await accepted.cleanup()
  }
  await expect(stageWorkspaceMultipart(multipart(body.replace(suffix, 'x' + suffix)))).rejects.toMatchObject({
    status: 413,
  })
})

for (const lines of [4096, 4097])
  test(`part header line boundary ${lines}`, async () => {
    const body = twoFiles(Array.from({ length: lines - 1 }, (_, i) => `X-${i}: x\r\n`).join(''))
    if (lines > 4096) {
      await expect(stageWorkspaceMultipart(multipart(body))).rejects.toMatchObject({ status: 400 })
      return
    }
    const staged = await stageWorkspaceMultipart(multipart(body))
    try {
      expect(staged.files).toHaveLength(2)
    } finally {
      await staged.cleanup()
    }
  })

for (const count of [1000, 1001])
  test(`file/path manifest row boundary ${count}`, async () => {
    const form = new FormData()
    for (let i = 0; i < count; i++) {
      form.append('f' + i, new File([], 'f' + i))
      form.append('path_f' + i, 'nested/f' + i)
    }
    for (let i = 0; i < 256; i++) form.append('extra' + i, 'value')
    const req = new Request('http://localhost/', { method: 'POST', body: form })
    if (count > 1000) {
      await expect(stageWorkspaceMultipart(req)).rejects.toMatchObject({ status: 400 })
      return
    }
    const staged = await stageWorkspaceMultipart(req)
    try {
      expect(staged.files).toHaveLength(1000)
      expect(staged.fields.size).toBe(1256)
    } finally {
      await staged.cleanup()
    }
  }, 15000)

test('path-looking fields require a corresponding file and cannot evade extra-field budget', async () => {
  const form = new FormData()
  for (let i = 0; i < 257; i++) form.append('path_fake' + i, 'metadata')
  await expect(
    stageWorkspaceMultipart(new Request('http://localhost/', { method: 'POST', body: form }))
  ).rejects.toMatchObject({ status: 400 })
})

test('one-byte chunks, false boundary prefixes, binary bytes and filename encoding match native formData', async () => {
  const raw = Buffer.from(
    '--test\r\nContent-Disposition: form-data; name="f"; filename="dir/é\\\\name.bin"\r\nContent-Type: application/octet-stream\r\n\r\nhello\0\xff\r\n--testX\r\n--test x\r\n--test\tbad\r\n--test \r\nend\r\n--test--\r\n',
    'latin1'
  )
  const previous = [
    ...(
      await new Response(raw, { headers: { 'content-type': 'multipart/form-data; boundary=test' } }).formData()
    ).values(),
  ][0] as unknown as File
  let offset = 0
  const request = new Request('http://localhost/', {
    method: 'POST',
    headers: { 'content-type': 'multipart/form-data; boundary="test"' },
    body: new ReadableStream({
      pull(c) {
        if (offset === raw.length) c.close()
        else c.enqueue(raw.subarray(offset, ++offset))
      },
    }),
  })
  const staged = await stageWorkspaceMultipart(request)
  try {
    expect(staged.files).toHaveLength(1)
    expect(staged.files[0]!.filename).toBe(previous.name)
    expect(await readFile(staged.files[0]!.tempPath)).toEqual(Buffer.from(await previous.arrayBuffer()))
  } finally {
    await staged.cleanup()
  }
})

test('late header/count/byte failures and source failure remove every stage and cancel input', async () => {
  const root = await mkdtemp(join(tmpdir(), 'multipart-cleanup-proof-'))
  const previous = process.env.TMPDIR
  process.env.TMPDIR = root
  try {
    const bodies = [twoFiles('Not-a-header\r\n'), twoFiles('X-Padding: ' + 'x'.repeat(4 * 1024 ** 2) + '\r\n')]
    const extra = new FormData()
    extra.append('file', new File(['first'], 'first'))
    for (let i = 0; i < 257; i++) extra.append('extra' + i, 'x')
    const requests = [...bodies.map(multipart), new Request('http://localhost/', { method: 'POST', body: extra })]
    let cancelled = false
    requests.push(
      new Request('http://localhost/', {
        method: 'POST',
        headers: { 'content-type': 'multipart/form-data; boundary=test' },
        body: new ReadableStream({
          start(c) {
            c.enqueue(Buffer.from(twoFiles('Broken-header\r\n')))
          },
          cancel() {
            cancelled = true
          },
        }),
      })
    )
    const abort = new AbortController()
    requests.push(
      new Request('http://localhost/', {
        method: 'POST',
        headers: { 'content-type': 'multipart/form-data; boundary=test' },
        signal: abort.signal,
        body: new ReadableStream({
          start(c) {
            c.enqueue(Buffer.from(twoFiles('').replace('--test--\r\n', '')))
          },
        }),
      })
    )
    for (let i = 0; i < requests.length; i++) {
      const promise = stageWorkspaceMultipart(requests[i]!)
      const timer = i === 4 ? setTimeout(() => abort.abort(), 30) : undefined
      try {
        await expect(promise).rejects.toThrow()
      } finally {
        if (timer) clearTimeout(timer)
      }
      expect(await readdir(root)).toEqual([])
    }
    expect(cancelled).toBe(true)
  } finally {
    if (previous === undefined) delete process.env.TMPDIR
    else process.env.TMPDIR = previous
    await rm(root, { recursive: true, force: true })
  }
})

test('aggregate field bytes are decoded UTF-8, preserving BOM handling at the exact limit', async () => {
  const prefix = '--test\r\nContent-Disposition: form-data; name="extra"\r\n\r\n'
  const suffix = '\r\n--test--\r\n'
  const bytes = 4 * 1024 ** 2 - Buffer.byteLength(prefix + suffix + 'testextra')
  const native = multipart(prefix + '\ufeff' + 'x'.repeat(bytes) + suffix)
  const staged = await stageWorkspaceMultipart(native)
  try {
    expect(staged.fields.get('extra')?.length).toBe(bytes)
  } finally {
    await staged.cleanup()
  }
})
for (const count of [1000, 1001])
  test(`duplicate corresponding path entry limit ${count}`, async () => {
    const form = new FormData()
    form.append('f', new File(['bytes'], 'name'))
    for (let i = 0; i < count; i++) form.append('path_f', 'first')
    const request = new Request('http://localhost/', { method: 'POST', body: form })
    if (count > 1000) {
      await expect(stageWorkspaceMultipart(request)).rejects.toMatchObject({ status: 400 })
      return
    }
    const staged = await stageWorkspaceMultipart(request)
    try {
      expect(staged.fields.get('path_f')).toBe('first')
    } finally {
      await staged.cleanup()
    }
  })

// Each case serially creates/reads/removes stages for every delimiter split, not just one parse.
// Keep its file-backed differential matrix in one test with an explicit 15-second budget.
for (const tail of ['--X', '--\rX', '--\n', '---', '-- ', '--\0'])
  test(`false closing prefix remains file bytes: ${JSON.stringify(tail)}`, async () => {
    const expected = Buffer.from('hello\r\n--test' + tail + 'still-file')
    const before = Buffer.from('--test\r\nContent-Disposition: form-data; name="first"; filename="first.bin"\r\n\r\n')
    const after = Buffer.from(
      '\r\n--test\r\nContent-Disposition: form-data; name="later"; filename="later.txt"\r\n\r\nlater contents\r\n--test--\r\n'
    )
    const raw = Buffer.concat([before, expected, after])
    const native = await new Response(raw, {
      headers: { 'content-type': 'multipart/form-data; boundary=test' },
    }).formData()
    const previous = native.get('first') as unknown as File
    expect(Buffer.from(await previous.arrayBuffer())).toEqual(expected)
    expect([...native.keys()]).toEqual(['first', 'later'])
    const candidateStart = before.length + 'hello'.length
    const splits = [
      -1,
      0,
      ...Array.from({ length: Buffer.byteLength('\r\n--test' + tail) + 2 }, (_, i) => candidateStart + i),
    ]
    for (const split of splits) {
      let offset = 0
      const request = new Request('http://localhost/', {
        method: 'POST',
        headers: { 'content-type': 'multipart/form-data; boundary=test' },
        body:
          split === -1
            ? raw
            : new ReadableStream({
                pull(c) {
                  if (offset === raw.length) {
                    c.close()
                    return
                  }
                  const end = split === 0 ? offset + 1 : offset === 0 ? split : raw.length
                  c.enqueue(raw.subarray(offset, end))
                  offset = end
                },
              }),
      })
      const staged = await stageWorkspaceMultipart(request)
      try {
        expect(staged.files.map((f) => f.filename)).toEqual(['first.bin', 'later.txt'])
        expect(await readFile(staged.files[0]!.tempPath)).toEqual(expected)
        expect(staged.files[0]!.bytes).toBe(expected.length)
        expect(staged.files[0]!.sha256).toBe(createHash('sha256').update(expected).digest('hex'))
        expect(await readFile(staged.files[1]!.tempPath, 'utf8')).toBe('later contents')
      } finally {
        await staged.cleanup()
      }
    }
  }, 15000)

for (const ending of ['', '\r\n', '\r\nepilogue'])
  test(`valid closing delimiter ${JSON.stringify(ending)} survives one-byte reads`, async () => {
    const raw = Buffer.from(
      '--test\r\nContent-Disposition: form-data; name="file"; filename="f"\r\n\r\ncontent\r\n--test--' + ending
    )
    const previous = (
      await new Response(raw, { headers: { 'content-type': 'multipart/form-data; boundary=test' } }).formData()
    ).get('file') as unknown as File
    let i = 0
    const staged = await stageWorkspaceMultipart(
      new Request('http://localhost/', {
        method: 'POST',
        headers: { 'content-type': 'multipart/form-data; boundary=test' },
        body: new ReadableStream({
          pull(c) {
            if (i === raw.length) c.close()
            else c.enqueue(raw.subarray(i, ++i))
          },
        }),
      })
    )
    try {
      expect(await readFile(staged.files[0]!.tempPath)).toEqual(Buffer.from(await previous.arrayBuffer()))
    } finally {
      await staged.cleanup()
    }
  })

for (const ending of ['\r\n--test-', '\r\n--test--\r', '\r\n--test--X'])
  test(`incomplete closing framing fails closed ${JSON.stringify(ending)}`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'closing-cleanup-'))
    const previous = process.env.TMPDIR
    process.env.TMPDIR = root
    try {
      await expect(
        stageWorkspaceMultipart(
          multipart('--test\r\nContent-Disposition: form-data; name="file"; filename="f"\r\n\r\ncontent' + ending)
        )
      ).rejects.toMatchObject({ status: 400 })
      expect(await readdir(root)).toEqual([])
    } finally {
      if (previous === undefined) delete process.env.TMPDIR
      else process.env.TMPDIR = previous
      await rm(root, { recursive: true, force: true })
    }
  })
