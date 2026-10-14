import { afterEach, describe, expect, it, mock } from 'bun:test'
import { Command } from 'commander'
import { apiGetRaw, apiPost } from '../client'
import { outputError, setOutputOptions } from '../output'
import { registerImageCommands } from './image'

const id = '3e371db3-0a76-4fdd-996c-491d497abbb8'

async function run(args: string[]) {
  const program = new Command()
  program.exitOverride()
  program.option('--json')
  program.option('--quiet')
  program.hook('preAction', (command) => setOutputOptions(command.optsWithGlobals()))
  registerImageCommands(program)
  await program.parseAsync(args, { from: 'user' })
}

describe('ficus image get', () => {
  afterEach(() => mock.restore())

  it('downloads from a signed URL, since unsigned image URLs are refused', async () => {
    const signed = `/api/images/${id}?exp=1&sig=abc`
    ;(apiPost as ReturnType<typeof mock>).mockResolvedValueOnce({ urls: { [id]: signed } })
    ;(apiGetRaw as ReturnType<typeof mock>).mockResolvedValueOnce(
      new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } })
    )
    const write = mock(() => true)
    const original = process.stdout.write
    process.stdout.write = write as never
    try {
      await run(['image', 'get', id])
    } finally {
      process.stdout.write = original
    }
    expect(apiPost).toHaveBeenCalledWith('/api/images/sign-urls', { ids: [id] })
    expect(apiGetRaw).toHaveBeenCalledWith(signed)
    expect(write).toHaveBeenCalledTimes(1)
  })

  it('says so when the image cannot be read, without fetching it', async () => {
    ;(apiPost as ReturnType<typeof mock>).mockResolvedValueOnce({ urls: {} })
    ;(apiGetRaw as ReturnType<typeof mock>).mockClear()
    await run(['image', 'get', id])
    expect(apiGetRaw).not.toHaveBeenCalled()
    expect((outputError as ReturnType<typeof mock>).mock.calls.at(-1)?.[0]).toBeInstanceOf(Error)
    expect(String((outputError as ReturnType<typeof mock>).mock.calls.at(-1)?.[0])).toContain(
      `Image ${id} not found, or you cannot read it`
    )
  })
})
