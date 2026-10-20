import { afterEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { serveSharedOnUnix, type UpstreamServeApi } from './serve-shim'

const roots: string[] = []
const servers: { stop(force?: boolean): unknown }[] = []
afterEach(async () => {
  for (const server of servers.splice(0)) server.stop(true)
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture(options: { shared?: boolean; storeInside?: boolean; busy?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'bigbrain-shim-'))
  roots.push(root)
  const vault = join(root, 'vault')
  await mkdir(vault)
  await mkdir(join(root, 'run'))
  await writeFile(join(vault, 'vault.yaml'), options.shared === false ? 'shared: false\n' : 'shared: true\n')
  const store = options.storeInside ? join(vault, 'members.json') : join(root, 'members.json')
  await writeFile(store, '{}')
  const order: string[] = []
  const api: UpstreamServeApi = {
    holdSharedVault: () => (order.push('lock'), options.busy ? null : { release: () => void order.push('release') }),
    SharedVault: class {
      constructor() {
        order.push('open')
      }
      recoverPending() {
        order.push('recover')
      }
      head() {
        return 'h'
      }
    },
    makeSharedApiHandler: (deps) => {
      order.push(`handler:${deps.connector?.publicUrl}`)
      return async (req) => new Response(`upstream ${new URL(req.url).pathname} host=${req.headers.get('host')}`)
    },
    MAX_SHARED_REQUEST_BYTES: 1024,
    ensureDir: () => void order.push('state'),
    parseYaml: (text) => ({ shared: text.includes('true') }),
    parsePublicUrl: (raw) => raw,
  }
  const socket = join(root, 'run', 'http.sock')
  const args = ['--vault', vault, '--members', store, '--socket', socket, '--public-url', 'https://bb-x.example.com']
  return { root, api, args, socket, order }
}

test('serves the pinned upstream handler only on the Unix socket, in upstream serve order, group-accessible 0660', async () => {
  const f = await fixture()
  servers.push(serveSharedOnUnix(f.api, f.args))
  expect(f.order).toEqual(['state', 'lock', 'open', 'recover', 'handler:https://bb-x.example.com'])
  expect((await stat(f.socket)).mode & 0o777).toBe(0o660)
  const response = await fetch('http://bb-x.example.com/v1/whoami', { unix: f.socket })
  expect(await response.text()).toBe('upstream /v1/whoami host=bb-x.example.com')
})

test('refuses a non-shared vault, a member store inside the vault, a busy writer lock and a non-socket at the path', async () => {
  for (const options of [{ shared: false }, { storeInside: true }]) {
    const f = await fixture(options)
    expect(() => serveSharedOnUnix(f.api, f.args)).toThrow('invalid_request')
    expect(f.order).toEqual([])
  }
  const busy = await fixture({ busy: true })
  expect(() => serveSharedOnUnix(busy.api, busy.args)).toThrow('busy')
  const planted = await fixture()
  await writeFile(planted.socket, 'not a socket')
  expect(() => serveSharedOnUnix(planted.api, planted.args)).toThrow('invalid_request')
})

test('argv is a fixed shape; extra or missing flags never start a server', async () => {
  const f = await fixture()
  expect(() => serveSharedOnUnix(f.api, [...f.args, '--host', '0.0.0.0'])).toThrow('invalid_request')
  expect(() => serveSharedOnUnix(f.api, f.args.slice(0, 6))).toThrow('invalid_request')
  expect(f.order).toEqual([])
})
