import { afterEach, describe, expect, it, mock } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Command } from 'commander'
import { apiDelete, apiFetch, apiGet, apiPost } from '../client'
import { output, outputError, setOutputOptions } from '../output'
import { registerWorkstreamAttachmentCommands } from './workstream-attachments'

const stream = 'stream-1'
const imageId = '3e371db3-0a76-4fdd-996c-491d497abbb8'
const share = {
  id: '5a0b1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d',
  workStreamId: stream,
  attemptId: null,
  source: { kind: 'image', imageId },
  filename: `${imageId}.png`,
  contentType: 'image/png',
  byteSize: 4,
  createdAt: '2026-10-30T00:00:00.000Z',
}

async function run(args: string[]) {
  const program = new Command()
  program.exitOverride()
  program.option('--json')
  program.hook('preAction', (command) => setOutputOptions(command.optsWithGlobals()))
  registerWorkstreamAttachmentCommands(program.command('workstream'))
  await program.parseAsync(['workstream', ...args], { from: 'user' })
}
const lastError = () => (outputError as ReturnType<typeof mock>).mock.calls.at(-1)?.[0] as Error | undefined

describe('ficus workstream attachment', () => {
  const dirs: string[] = []
  afterEach(async () => {
    mock.restore()
    ;(outputError as ReturnType<typeof mock>).mockClear()
    setOutputOptions({ json: false })
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  })

  it('add shares a stored image or chat file by ID, with exactly one source', async () => {
    ;(apiPost as ReturnType<typeof mock>).mockResolvedValueOnce(share)
    await run(['attachment', 'add', stream, '--image', imageId])
    expect(apiPost).toHaveBeenCalledWith(`/api/workstreams/${stream}/asset-attachments`, {
      source: { kind: 'image', imageId },
    })
    ;(apiPost as ReturnType<typeof mock>).mockResolvedValueOnce(share)
    await run(['attachment', 'add', stream, '--agent-file', imageId])
    expect(apiPost).toHaveBeenLastCalledWith(`/api/workstreams/${stream}/asset-attachments`, {
      source: { kind: 'agent-file', attachmentId: imageId },
    })
    const calls = (apiPost as ReturnType<typeof mock>).mock.calls.length
    await run(['attachment', 'add', stream])
    expect(lastError()?.message).toBe('Give exactly one of --image IMAGE_ID or --agent-file FILE_ATTACHMENT_ID')
    await run(['attachment', 'add', stream, '--image', imageId, '--agent-file', imageId])
    expect((apiPost as ReturnType<typeof mock>).mock.calls.length).toBe(calls)
  })

  it('list reads metadata only; nothing is downloaded', async () => {
    ;(apiGet as ReturnType<typeof mock>).mockResolvedValueOnce({ inputs: [share], attempts: {} })
    ;(apiFetch as ReturnType<typeof mock>).mockClear()
    const log = mock(() => {})
    const original = console.log
    console.log = log
    try {
      await run(['attachment', 'list', stream])
    } finally {
      console.log = original
    }
    expect(apiGet).toHaveBeenCalledWith(`/api/workstreams/${stream}/asset-attachments`)
    expect(apiFetch).not.toHaveBeenCalled()
    const printed = log.mock.calls.map((call) => String((call as unknown[])[0])).join('\n')
    expect(printed).toContain(`${share.id}  ${share.filename}  image/png  4 bytes  (image ${imageId})`)
    expect(printed).toContain('read_attachment')
  })

  it('get saves a stored reference, and falls back to a handoff file of the same stream', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ficus-attachment-get-'))
    dirs.push(dir)
    const out = join(dir, 'shot.png')
    ;(apiFetch as ReturnType<typeof mock>).mockResolvedValueOnce(new Response(new Uint8Array([137, 80, 78, 71])))
    await run(['attachment', 'get', stream, share.id, '--out', out])
    expect(apiFetch).toHaveBeenLastCalledWith(`/api/workstreams/${stream}/asset-attachments/${share.id}`)
    expect([...(await readFile(out))]).toEqual([137, 80, 78, 71])
    // --json still writes the file: metadata output never silently replaces the download.
    setOutputOptions({ json: true })
    ;(apiFetch as ReturnType<typeof mock>)
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'Attachment not found' }), { status: 404 }))
      .mockResolvedValueOnce(new Response('# Notes'))
    const handoff = join(dir, 'notes.md')
    await run(['attachment', 'get', stream, 'handoff-id', '--out', handoff])
    expect(apiFetch).toHaveBeenLastCalledWith(`/api/workflows/runs/${stream}/attachments/handoff-id`)
    expect(await readFile(handoff, 'utf8')).toBe('# Notes')
    expect(output).toHaveBeenLastCalledWith({ id: 'handoff-id', size: 7, out: handoff }, `Saved 7 bytes to ${handoff}`)
    ;(apiFetch as ReturnType<typeof mock>)
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'Attachment not found' }), { status: 404 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'Attachment not found' }), { status: 404 }))
    await run(['attachment', 'get', stream, 'missing', '--out', join(dir, 'missing')])
    expect(lastError()?.message).toBe('Attachment not found')
  })

  it('remove deletes the share, not the source', async () => {
    ;(apiDelete as ReturnType<typeof mock>).mockResolvedValueOnce({ success: true })
    await run(['attachment', 'remove', stream, share.id])
    expect(apiDelete).toHaveBeenCalledWith(`/api/workstreams/${stream}/asset-attachments/${share.id}`)
  })
})
