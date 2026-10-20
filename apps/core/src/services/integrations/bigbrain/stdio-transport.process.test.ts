import { BigbrainClient } from './client'
import { expect, test } from 'bun:test'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BigbrainStdioTransport, stopAllBigbrainProcesses } from './stdio-transport'
import { createSyntheticBigbrain, createSyntheticVault } from './synthetic-upstream.fixture'

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

test('reaps a wrapper and its TERM-resistant child after an initialized session', async () => {
  const f = await fixture(`
    process.on('SIGTERM',()=>{});
    const child = Bun.spawn([process.execPath,'--no-install','-e', "process.on('SIGTERM',()=>{}); console.log('ready'); setInterval(()=>{},1000)"],{stdout:'pipe',stderr:'ignore'});
    await child.stdout.getReader().read();
    console.log(JSON.stringify({jsonrpc:'2.0',id:1,result:{pid:child.pid}}));
    setInterval(()=>{},1000);
  `)
  try {
    const ready = new Promise<number>((resolve) => {
      f.transport.onmessage = (message) => resolve((message as any).result.pid)
    })
    await f.transport.start()
    const child = await ready
    await f.transport.close()
    let running = false
    try {
      const state = await readFile(`/proc/${child}/stat`, 'utf8')
      running = !state.split(' ')[2].includes('Z')
    } catch {
      /* reaped */
    }
    expect(running).toBe(false)
    expect(() => process.kill(f.transport.pid!, 0)).toThrow()
  } finally {
    await f.dispose()
  }
})

test('a dispatched drop timeout has an unknown outcome and is not retried', async () => {
  const f = await fixture(`
    let buffer=''; process.stdin.on('data',data=>{buffer+=data; while(buffer.includes('\\n')){const i=buffer.indexOf('\\n');const m=JSON.parse(buffer.slice(0,i));buffer=buffer.slice(i+1);if(m.method==='initialize') console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{protocolVersion:m.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'synthetic',version:'1'}}}));}}); setInterval(()=>{},1000);
  `)
  try {
    const client = new BigbrainClient({ transport: async () => f.transport, writeMs: 2500 })
    await expect(client.drop({ title: 'synthetic', body: 'not a transcript' })).rejects.toMatchObject({
      code: 'outcome_unknown',
    })
    expect(() => process.kill(f.transport.pid!, 0)).toThrow()
  } finally {
    await f.dispose()
  }
})

test('shutdown during asynchronous startup cannot launch an untracked process', async () => {
  const f = await fixture('setInterval(()=>{},1000)')
  try {
    const starting = f.transport.start()
    await stopAllBigbrainProcesses()
    await starting.catch(() => {})
    if (f.transport.pid) expect(() => process.kill(f.transport.pid!, 0)).toThrow()
  } finally {
    if (f.transport.pid) {
      try {
        process.kill(-f.transport.pid, 'SIGKILL')
      } catch {
        /* gone */
      }
    }
    await f.dispose()
  }
})

test('startup deadline reports timeout and reaps an unresponsive MCP process', async () => {
  const f = await fixture('setInterval(()=>{},1000)')
  try {
    const client = new BigbrainClient({ transport: async () => f.transport, startupMs: 100, readMs: 3000 })
    await expect(client.loadMemory()).rejects.toMatchObject({ code: 'timeout' })
    expect(() => process.kill(f.transport.pid!, 0)).toThrow()
  } finally {
    await f.dispose()
  }
})

test('caller abort during startup cancels and reaps the owned process', async () => {
  const f = await fixture('setInterval(()=>{},1000)')
  const controller = new AbortController()
  const start = f.transport.start.bind(f.transport)
  f.transport.start = async () => {
    await start()
    controller.abort()
  }
  try {
    const client = new BigbrainClient({ transport: async () => f.transport })
    await expect(client.loadMemory({ signal: controller.signal })).rejects.toMatchObject({ code: 'cancelled' })
    expect(() => process.kill(f.transport.pid!, 0)).toThrow()
  } finally {
    await f.dispose()
  }
})

test('a descendant that escaped the process group and holds the pipes cannot wedge cleanup', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'bigbrain-stdio-escaped-')))
  const bigbrain = await createSyntheticBigbrain(root, join(root, 'home'))
  const vaultPath = await createSyntheticVault(join(root, 'vault'))
  const escapedPids = async () =>
    (await bigbrain.launches()).flatMap((entry) => ('escapedPid' in entry ? [Number(entry.escapedPid)] : []))
  const launch = async (mode: 'escaped-child' | 'escaped-child-ok') => {
    await bigbrain.setMode(mode)
    const before = (await escapedPids()).length
    const transport = new BigbrainStdioTransport({
      executablePath: bigbrain.executable,
      vaultPath,
      clientId: 'aabb0011',
    })
    const failed = new Promise<{ error: Error; at: number }>((resolve) => {
      transport.onerror = (error) => resolve({ error, at: Date.now() })
    })
    const closed = new Promise<number>((resolve) => {
      transport.onclose = () => resolve(Date.now())
    })
    await transport.start()
    while ((await escapedPids()).length === before) await new Promise((resolve) => setTimeout(resolve, 20))
    return { transport, failed, closed }
  }
  try {
    // A live session with an escaped pipe holder: close() settles within its bounded grace.
    const live = await launch('escaped-child')
    const closing = Date.now()
    await live.transport.close()
    expect(Date.now() - closing).toBeLessThan(3000)
    expect(() => process.kill(live.transport.pid!, 0)).toThrow()
    // A wrapper that exits on its own while the holder lingers still closes promptly.
    const exited = await launch('escaped-child-ok')
    const failure = await exited.failed
    expect(failure.error).toMatchObject({ code: 'unavailable' })
    expect((await exited.closed) - failure.at).toBeLessThan(3000)
    expect(() => process.kill(exited.transport.pid!, 0)).toThrow()
    // The holders really were still alive: this is what kept 'close' from firing.
    const holders = await escapedPids()
    expect(holders).toHaveLength(2)
    for (const pid of holders) expect(() => process.kill(pid, 0)).not.toThrow()
  } finally {
    for (const pid of await escapedPids()) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        /* already gone */
      }
    }
    await rm(root, { recursive: true, force: true })
  }
}, 20000)
