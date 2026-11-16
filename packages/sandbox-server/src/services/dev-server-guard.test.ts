import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { createServer, type Server } from 'node:net'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  checkDevServerPort,
  devServerGuardMessage,
  devServerPort,
  findPortHolder,
  listeningInodes,
} from './dev-server-guard'

describe('devServerPort', () => {
  it.each([
    ['next dev --port 34562', 34562],
    ['cd admin && npx next dev -p 3001', 3001],
    ['PORT=4000 npm run dev', 4000],
    ['pnpm dev -- --port=5174', 5174],
    ['bunx vite --port 5173 --host 127.0.0.1', 5173],
    ['nohup next dev --port 34562 > /tmp/dev.log 2>&1 &', 34562],
    ['python3 -m http.server 8000', 8000],
    ['uvicorn app:api --port 8001', 8001],
    ['python manage.py runserver 0.0.0.0:8002', 8002],
    ['php -S 127.0.0.1:8003', 8003],
  ])('recognizes %s', (command, port) => {
    expect(devServerPort(command)).toBe(port)
  })

  it.each([
    'next build',
    'npm run dev',
    'mkdir -p 3000',
    'curl http://localhost:3000',
    'git log -p 20',
    'kill 1234; next dev --port 3000',
    'lsof -ti:3000 | xargs -r kill; npm run dev -- --port 3000',
  ])('leaves %s alone (not a dev server, no explicit port, or replacing one)', (command) => {
    expect(devServerPort(command)).toBeUndefined()
  })
})

const TCP_HEADER = '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n'
function tcpRow(port: number, state: string, uid: number, inode: number): string {
  const hex = port.toString(16).toUpperCase().padStart(4, '0')
  return `   0: 0100007F:${hex} 00000000:0000 ${state} 00000000:00000000 00:00000000 00000000  ${uid}        0 ${inode} 1 0000000000000000 100 0 0 10 0\n`
}

describe('listeningInodes', () => {
  it('returns only LISTEN sockets on the port owned by the uid', () => {
    const table =
      TCP_HEADER +
      tcpRow(34562, '0A', 1001, 111) +
      tcpRow(34562, '01', 1001, 222) +
      tcpRow(34562, '0A', 1002, 333) +
      tcpRow(3000, '0A', 1001, 444)
    expect(listeningInodes(table, 34562, 1001)).toEqual(['111'])
  })
})

describe('findPortHolder (fake /proc)', () => {
  let proc: string
  beforeEach(() => {
    proc = mkdtempSync(join(tmpdir(), 'ficus-proc-'))
    mkdirSync(join(proc, 'net'))
    writeFileSync(join(proc, 'net', 'tcp'), TCP_HEADER + tcpRow(34562, '0A', 1001, 9876))
    writeFileSync(join(proc, 'net', 'tcp6'), TCP_HEADER)
    for (const [pid, inode] of [
      ['200', 1],
      ['4321', 9876],
    ] as const) {
      mkdirSync(join(proc, pid, 'fd'), { recursive: true })
      symlinkSync(`socket:[${inode}]`, join(proc, pid, 'fd', '19'))
      writeFileSync(join(proc, pid, 'cmdline'), `next-server (v15.1.0)\0`)
      symlinkSync('/home/box_aaaaaaaaaaaa/workspace/worktrees/one/admin', join(proc, pid, 'cwd'))
    }
  })
  afterEach(() => rmSync(proc, { recursive: true, force: true }))

  it('names the process holding the port', async () => {
    expect(await findPortHolder(34562, { procRoot: proc, uid: 1001 })).toEqual({
      pid: 4321,
      command: 'next-server (v15.1.0)',
      cwd: '/home/box_aaaaaaaaaaaa/workspace/worktrees/one/admin',
    })
  })

  it('ignores another box (uid) and free ports', async () => {
    expect(await findPortHolder(34562, { procRoot: proc, uid: 1002 })).toBeUndefined()
    expect(await findPortHolder(3000, { procRoot: proc, uid: 1001 })).toBeUndefined()
  })

  it('refuses the second next dev with a message naming the first', async () => {
    const message = await checkDevServerPort('cd ../two/admin && next dev --port 34562', {
      procRoot: proc,
      uid: 1001,
      platform: 'linux',
    })
    expect(message).toBe(
      'Refusing to start a dev server on port 34562: it is already in use in this box by process 4321 ' +
        '(next-server (v15.1.0)), running in /home/box_aaaaaaaaaaaa/workspace/worktrees/one/admin. ' +
        'A second copy would not get the port and would double the memory this box uses. ' +
        'Use the server that is already running, or stop it first (kill 4321) and then start it again.'
    )
  })

  it('does not check off Linux', async () => {
    expect(await checkDevServerPort('next dev --port 34562', { procRoot: proc, uid: 1001, platform: 'darwin' })).toBe(
      undefined
    )
  })
})

describe('devServerGuardMessage', () => {
  it('still refuses when the holder process cannot be identified', () => {
    expect(devServerGuardMessage(3000, {})).toContain('already in use in this box by a process of this box')
  })
})

describe('checkDevServerPort against the real /proc', () => {
  let server: Server | undefined
  afterEach(() => server?.close())

  it.skipIf(process.platform !== 'linux')('finds this test process listening on a real port', async () => {
    server = createServer()
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as { port: number }).port
    const message = await checkDevServerPort(`next dev --port ${port}`)
    expect(message).toContain(`Refusing to start a dev server on port ${port}`)
    expect(message).toContain(`process ${process.pid}`)
  })
})
