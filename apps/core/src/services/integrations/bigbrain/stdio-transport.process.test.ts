import { expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BigbrainStdioTransport, stopAllBigbrainProcesses } from './stdio-transport'

async function fixture(source: string) {
  const root = await mkdtemp(join(tmpdir(), 'bigbrain-stdio-'))
  const executablePath = join(root, 'server')
  await writeFile(executablePath, `#!${process.execPath}\n${source}`, { mode: 0o700 })
  const transport = new BigbrainStdioTransport({ executablePath, vaultPath: root, clientId: 'aabb0011' })
  return {
    transport,
    dispose: async () => {
      await transport.close()
      await rm(root, { recursive: true, force: true })
    },
  }
}
test('frames split messages and shuts down the exact process group', async () => {
  const f = await fixture(
    `process.stdout.write('{"jsonrpc":"2.0",'); process.stdout.write('"id":1,"result":{}}\\n'); setInterval(()=>{},1000)`
  )
  try {
    const message = new Promise((resolve) => {
      f.transport.onmessage = resolve
    })
    await f.transport.start()
    const pid = f.transport.pid!
    expect(await message).toMatchObject({ id: 1, result: {} })
    await f.transport.close()
    expect(() => process.kill(pid, 0)).toThrow()
  } finally {
    await f.dispose()
  }
})
test.each([
  [`process.stdout.write('x'.repeat(1048577)); setInterval(()=>{},1000)`, 'response_too_large'],
  [`process.stdout.write('not json\\n'); setInterval(()=>{},1000)`, 'invalid_response'],
  [`process.stderr.write('SECRET'.repeat(12000)); setInterval(()=>{},1000)`, 'response_too_large'],
])('bounds and sanitizes malicious stdio %s', async (source, code) => {
  const f = await fixture(source)
  try {
    const error = new Promise<Error>((resolve) => {
      f.transport.onerror = resolve
    })
    await f.transport.start()
    expect(await error).toMatchObject({ code })
    await f.transport.close()
  } finally {
    await f.dispose()
  }
})
test('caps concurrent sessions and stop-all reaps them', async () => {
  const fixtures = await Promise.all([1, 2, 3].map(() => fixture('setInterval(()=>{},1000)')))
  try {
    await fixtures[0].transport.start()
    await fixtures[1].transport.start()
    await expect(fixtures[2].transport.start()).rejects.toMatchObject({ code: 'busy' })
    await stopAllBigbrainProcesses()
    expect(() => process.kill(fixtures[0].transport.pid!, 0)).toThrow()
  } finally {
    await Promise.all(fixtures.map((f) => f.dispose()))
  }
})
