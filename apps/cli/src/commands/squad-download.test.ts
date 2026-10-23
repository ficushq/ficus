import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { Command } from 'commander'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { apiFetch } from '../client'
import { isJsonMode, output, outputError, setOutputOptions } from '../output'
import { downloadSquadFile, resolveDownloadTarget } from './squad-download'
import { registerSquadCommands } from './squad'

let cwd: string

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'cli-download-'))
})

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true })
})

const FULL = Buffer.from('0123456789')

interface Seen {
  path: string
  range: string | null
  acceptEncoding: string | null
}

function server(handler: (seen: Seen) => Response) {
  const seen: Seen[] = []
  const request = async (path: string, init: RequestInit) => {
    const headers = new Headers(init.headers)
    const entry = { path, range: headers.get('range'), acceptEncoding: headers.get('accept-encoding') }
    seen.push(entry)
    return handler(entry)
  }
  return { request, seen }
}

/** A chunked stream body (no Content-Length), like Core's streamed responses. */
function streamed(chunks: Uint8Array[], options: { failAfter?: number } = {}) {
  let index = 0
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (options.failAfter !== undefined && index === options.failAfter) {
        controller.error(new Error('connection reset'))
        return
      }
      if (index < chunks.length) controller.enqueue(chunks[index++])
      else controller.close()
    },
  })
}

const silent = { isTTY: false, write: () => true }

describe('downloadSquadFile', () => {
  it('streams the file to the remote basename in cwd and verifies the announced length', async () => {
    const { request, seen } = server(
      () =>
        new Response(streamed([FULL.subarray(0, 4), FULL.subarray(4)]), {
          headers: { 'x-ficus-content-length': '10' },
        })
    )
    const result = await downloadSquadFile('sq 1', 'docs/data.bin', {}, { request, cwd, progress: silent })
    expect(result).toEqual({ path: join(cwd, 'data.bin'), bytes: 10, status: 200 })
    expect(readFileSync(join(cwd, 'data.bin'))).toEqual(FULL)
    expect(seen[0].range).toBeNull()
    expect(seen[0].acceptEncoding).toBe('identity')
    expect(seen[0].path).toBe('/api/squads/sq%201/workspace/download?path=docs%2Fdata.bin')
  })

  it('--resume sends Range from the partial size and appends the 206 body', async () => {
    writeFileSync(join(cwd, 'data.bin'), FULL.subarray(0, 4))
    const { request, seen } = server(
      () =>
        new Response(streamed([FULL.subarray(4)]), {
          status: 206,
          headers: { 'content-range': 'bytes 4-9/10', 'x-ficus-content-length': '6' },
        })
    )
    const result = await downloadSquadFile('sq', 'data.bin', { resume: true }, { request, cwd, progress: silent })
    expect(seen[0].range).toBe('bytes=4-')
    expect(result).toEqual({ path: join(cwd, 'data.bin'), bytes: 10, status: 206 })
    expect(readFileSync(join(cwd, 'data.bin'))).toEqual(FULL)
  })

  it('--resume on a complete file reports done on 416', async () => {
    writeFileSync(join(cwd, 'data.bin'), FULL)
    const { request } = server(
      () =>
        new Response('{"error":"Requested range not satisfiable"}', {
          status: 416,
          headers: { 'content-range': 'bytes */10' },
        })
    )
    const result = await downloadSquadFile('sq', 'data.bin', { resume: true }, { request, cwd, progress: silent })
    expect(result).toEqual({ path: join(cwd, 'data.bin'), bytes: 10, status: 416 })
    expect(readFileSync(join(cwd, 'data.bin'))).toEqual(FULL)
  })

  it('--resume restarts from scratch when the server answers a full 200', async () => {
    writeFileSync(join(cwd, 'data.bin'), Buffer.from('XXXX'))
    const { request } = server(() => new Response(FULL, { headers: { 'x-ficus-content-length': '10' } }))
    const result = await downloadSquadFile('sq', 'data.bin', { resume: true }, { request, cwd, progress: silent })
    expect(result.status).toBe(200)
    expect(readFileSync(join(cwd, 'data.bin'))).toEqual(FULL)
  })

  it('fails and deletes the partial file when fewer bytes arrive than announced', async () => {
    const { request } = server(
      () => new Response(streamed([FULL.subarray(0, 6)]), { headers: { 'x-ficus-content-length': '10' } })
    )
    await expect(downloadSquadFile('sq', 'data.bin', {}, { request, cwd, progress: silent })).rejects.toThrow(
      'Size mismatch: received 6 of 10 bytes'
    )
    expect(existsSync(join(cwd, 'data.bin'))).toBe(false)
  })

  it('keeps the partial file on a mismatch under --resume so it can be resumed again', async () => {
    writeFileSync(join(cwd, 'data.bin'), FULL.subarray(0, 2))
    const { request } = server(
      () =>
        new Response(streamed([FULL.subarray(2, 5)]), {
          status: 206,
          headers: { 'content-range': 'bytes 2-9/10', 'x-ficus-content-length': '8' },
        })
    )
    await expect(
      downloadSquadFile('sq', 'data.bin', { resume: true }, { request, cwd, progress: silent })
    ).rejects.toThrow('partial file kept')
    expect(readFileSync(join(cwd, 'data.bin'))).toEqual(FULL.subarray(0, 5))
  })

  it('fails and deletes the partial file when the stream breaks mid-transfer', async () => {
    const { request } = server(() => new Response(streamed([FULL.subarray(0, 3), FULL.subarray(3)], { failAfter: 1 })))
    await expect(downloadSquadFile('sq', 'data.bin', {}, { request, cwd, progress: silent })).rejects.toThrow(
      'Download interrupted after 3 bytes'
    )
    expect(existsSync(join(cwd, 'data.bin'))).toBe(false)
  })

  it('refuses a directory without --archive and saves <name>.tar.gz with it', async () => {
    const { request, seen } = server(
      () =>
        new Response(streamed([Buffer.from('tgz')]), {
          headers: { 'content-type': 'application/gzip', 'x-ficus-archive': 'tar.gz' },
        })
    )
    await expect(downloadSquadFile('sq', 'project/', {}, { request, cwd, progress: silent })).rejects.toThrow(
      're-run with --archive'
    )
    expect(existsSync(join(cwd, 'project'))).toBe(false)

    const result = await downloadSquadFile('sq', 'project/', { archive: true }, { request, cwd, progress: silent })
    expect(new URL(`http://x${seen[1].path}`).searchParams.get('archive')).toBe('tar.gz')
    expect(result.path).toBe(join(cwd, 'project.tar.gz'))
    expect(readFileSync(result.path, 'utf8')).toBe('tgz')
  })

  it('rejects --archive with --resume and surfaces API errors', async () => {
    await expect(downloadSquadFile('sq', 'd', { archive: true, resume: true }, { cwd })).rejects.toThrow(
      '--resume cannot be combined with --archive'
    )
    const { request } = server(() => Response.json({ error: 'File not found' }, { status: 404 }))
    await expect(downloadSquadFile('sq', 'nope.bin', {}, { request, cwd, progress: silent })).rejects.toMatchObject({
      status: 404,
      message: 'File not found',
    })
    expect(existsSync(join(cwd, 'nope.bin'))).toBe(false)
  })

  it('draws progress on a TTY only', async () => {
    const respond = () => new Response(FULL, { headers: { 'x-ficus-content-length': '10' } })
    const tty: string[] = []
    await downloadSquadFile(
      'sq',
      'a.bin',
      {},
      {
        request: server(respond).request,
        cwd,
        progress: { isTTY: true, write: (text) => tty.push(text) },
      }
    )
    expect(tty.join('')).toContain('a.bin: 10 B / 10 B (100%)')

    const pipe: string[] = []
    await downloadSquadFile(
      'sq',
      'b.bin',
      {},
      {
        request: server(respond).request,
        cwd,
        progress: { isTTY: false, write: (text) => pipe.push(text) },
      }
    )
    expect(pipe).toEqual([])
  })
})

describe('resolveDownloadTarget', () => {
  it('uses -o as a file, or as a directory when it is one', () => {
    mkdirSync(join(cwd, 'out'))
    expect(resolveDownloadTarget('a/b.bin', { output: 'x.bin' }, cwd)).toBe(join(cwd, 'x.bin'))
    expect(resolveDownloadTarget('a/b.bin', { output: 'out' }, cwd)).toBe(join(cwd, 'out', 'b.bin'))
    expect(resolveDownloadTarget('a/dir/', { output: 'out', archive: true }, cwd)).toBe(join(cwd, 'out', 'dir.tar.gz'))
    expect(resolveDownloadTarget('.', {}, cwd)).toBe(join(cwd, 'workspace'))
  })
})

describe('ficus squad download (command wiring)', () => {
  it('prints { path, bytes, status } in JSON mode', async () => {
    const previous = process.cwd()
    process.chdir(cwd)
    try {
      ;(apiFetch as ReturnType<typeof mock>).mockImplementation(
        async () => new Response(FULL, { headers: { 'x-ficus-content-length': '10' } })
      )
      ;(isJsonMode as ReturnType<typeof mock>).mockReturnValue(true)
      ;(output as ReturnType<typeof mock>).mockClear()
      const program = new Command()
      program.exitOverride()
      program.option('--json')
      program.hook('preAction', (command) => setOutputOptions(command.optsWithGlobals()))
      registerSquadCommands(program)
      await program.parseAsync(['--json', 'squad', 'download', 'sq', 'docs/c.bin'], { from: 'user' })
      expect(outputError).not.toHaveBeenCalled()
      expect((output as ReturnType<typeof mock>).mock.calls[0][0]).toEqual({
        path: join(process.cwd(), 'c.bin'),
        bytes: 10,
        status: 200,
      })
    } finally {
      process.chdir(previous)
    }
  })
})
