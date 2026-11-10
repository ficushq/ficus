import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { spawnSync } from 'child_process'
import { mkdtempSync, readFileSync, rmSync } from 'fs'
import net from 'node:net'
import tls from 'node:tls'
import { tmpdir } from 'os'
import { join } from 'path'
import { createPostgresConnection } from './connection'

/*
 * Regression guard for the Bun TLS STARTTLS leak (live on a tenant in 2026:
 * the api process grew to ~3 GB). postgres.js negotiates TLS by sending an
 * SSLRequest on a plain TCP socket, reading the server's 'S', then wrapping
 * that raw socket with tls.connect({ socket }). On Bun, a raw socket left
 * without a reader at that point kept a copy of every decrypted chunk in its
 * own readable buffer, forever. Core used to supply a socket factory to stop
 * that; with postgres.js 4 the factory was removed because v4 no longer
 * triggers the leak (measured on Bun 1.4.2: v3 without the guard retained all
 * of 210 MB streamed over TLS, v4 without any guard retained ~2 MB of heap).
 *
 * This test streams bytes from a fake TLS Postgres server through a real
 * createPostgresConnection client and checks that the raw TCP socket under the
 * TLS socket holds nothing afterwards. If a driver or Bun upgrade brings the
 * leak back, the raw socket's buffer holds roughly everything streamed.
 */

const STREAMED_FRAMES = 512
const FRAME_PAYLOAD_BYTES = 64 * 1024

function frame(type: string, body: Buffer): Buffer {
  const out = Buffer.alloc(5 + body.length)
  out.write(type, 0)
  out.writeInt32BE(4 + body.length, 1)
  body.copy(out, 5)
  return out
}

function int32(value: number): Buffer {
  const out = Buffer.alloc(4)
  out.writeInt32BE(value)
  return out
}

const readyForQuery = frame('Z', Buffer.from('I'))
const startupReply = Buffer.concat([
  frame('R', int32(0)), // AuthenticationOk
  frame('K', Buffer.concat([int32(1), int32(2)])), // BackendKeyData
  readyForQuery,
])
const notice = frame(
  'N',
  Buffer.concat([Buffer.from('SNOTICE\0M'), Buffer.alloc(FRAME_PAYLOAD_BYTES, 'x'), Buffer.from('\0\0')])
)
const queryDone = Buffer.concat([frame('C', Buffer.from('SELECT 0\0')), readyForQuery])

let certDir: string
let secureContext: tls.SecureContext

beforeAll(() => {
  certDir = mkdtempSync(join(tmpdir(), 'ficus-pg-tls-'))
  const keyPath = join(certDir, 'key.pem')
  const certPath = join(certDir, 'cert.pem')
  const generated = spawnSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      keyPath,
      '-out',
      certPath,
      '-days',
      '1',
      '-subj',
      '/CN=localhost',
    ],
    { encoding: 'utf8' }
  )
  if (generated.status !== 0) throw new Error(`openssl could not create a test certificate: ${generated.stderr}`)
  secureContext = tls.createSecureContext({ key: readFileSync(keyPath), cert: readFileSync(certPath) })
})

afterAll(() => {
  rmSync(certDir, { recursive: true, force: true })
})

/** A fake Postgres that accepts TLS, trusts any user, and answers the first query with a stream of notices. */
async function withFakeTlsPostgres<T>(fn: (port: number) => Promise<T>): Promise<T> {
  const sockets = new Set<net.Socket>()
  const server = net.createServer((raw) => {
    sockets.add(raw)
    raw.on('error', () => {})
    raw.once('data', () => {
      raw.write('S')
      const secure = new tls.TLSSocket(raw, { isServer: true, secureContext })
      secure.on('error', () => {})
      let started = false
      secure.on('data', async () => {
        if (!started) {
          started = true
          secure.write(startupReply)
          return
        }
        for (let i = 0; i < STREAMED_FRAMES; i++) {
          if (!secure.write(notice)) await new Promise((resolve) => secure.once('drain', resolve))
        }
        secure.write(queryDone)
      })
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    return await fn((server.address() as { port: number }).port)
  } finally {
    for (const socket of sockets) socket.destroy()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

describe('Bun TLS-upgrade leak (no Core socket factory on postgres.js 4)', () => {
  test('the raw TCP socket under a TLS connection retains none of the streamed bytes', async () => {
    // Every client TCP socket goes through net.Socket#connect (net.connect
    // calls it too), so wrapping it captures the raw socket postgres.js opens
    // whichever way it creates it. The fake server's sockets are accepted, not
    // connected, so they are not captured; on Bun the TLSSocket wrapping the
    // raw one also passes through connect, so TLS sockets are skipped.
    const rawSockets: net.Socket[] = []
    const originalConnect = net.Socket.prototype.connect
    net.Socket.prototype.connect = function (this: net.Socket, ...args: unknown[]) {
      if (!(this instanceof tls.TLSSocket)) rawSockets.push(this)
      return (originalConnect as (...connectArgs: unknown[]) => net.Socket).apply(this, args)
    } as typeof originalConnect
    try {
      await withFakeTlsPostgres(async (port) => {
        let notices = 0
        const sql = createPostgresConnection(`postgres://u:p@127.0.0.1:${port}/d?sslmode=require`, {
          max: 1,
          fetch_types: false,
          onnotice: () => notices++,
        })
        try {
          await sql.unsafe('select 0')
          expect(notices).toBe(STREAMED_FRAMES)
          expect(rawSockets).toHaveLength(1)
          const raw = rawSockets[0]
          // A leak leaves ~32 MB (STREAMED_FRAMES x 64 KB) buffered here.
          expect(raw.readableLength).toBeLessThan(1024 * 1024)
        } finally {
          await sql.end({ timeout: 1 })
        }
      })
    } finally {
      net.Socket.prototype.connect = originalConnect
    }
  })
})
